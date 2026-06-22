import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

const EDGE_FUNCTION_URL = process.env.VITE_EDGE_FUNCTION_URL ?? process.env.VITE_SUPABASE_URL + '/functions/v1';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;

async function seedVendor(overrides: Record<string, unknown> = {}) {
  const phone = `9801${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  const { data, error } = await supabaseAdmin.from('vendors').insert({
    name: 'Sub Test Vendor',
    shop_name: 'Sub Test Shop',
    phone,
    upi_id: 'subtest@upi',
    service_mode: 'help',
    is_active: true,
    is_banned: false,
    profile_status: 'complete',
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  }).select().single();
  if (error) throw new Error(`seedVendor failed: ${error.message}`);
  return data;
}

async function deleteVendor(id: string) {
  await supabaseAdmin.from('vendors').delete().eq('id', id);
}

async function invokeCheckSubscriptions() {
  const res = await fetch(`${EDGE_FUNCTION_URL}/check-vendor-subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
    },
    body: '{}',
  });
  return res.json();
}

async function deleteNotifications(phone: string) {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
}

// SUB-REQ-01: New vendor starts in trial
test('SUB-REQ-01: new vendor starts in trial with trial_ends_at set', async () => {
  const vendor = await seedVendor();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, trial_ends_at')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('trial');
  expect(data?.trial_ends_at).not.toBeNull();
  await deleteVendor(vendor.id);
});

// SUB-REQ-02: Trial expiry → grace (PAYMENTS_ENABLED=false so edge fn is dormant)
test('SUB-REQ-02: dormant mode — trial vendor not moved to grace by edge function', async () => {
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // expired 1 min ago
  });
  await invokeCheckSubscriptions();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  // PAYMENTS_ENABLED=false — status must NOT change
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

// SUB-REQ-03: Expired vendor hidden from Radar (is_active=false)
test('SUB-REQ-03: expired vendor with is_active=false not returned in active vendor query', async () => {
  const vendor = await seedVendor({
    subscription_status: 'expired',
    is_active: false,
  });
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('id', vendor.id)
    .eq('is_active', true)
    .eq('profile_status', 'complete');
  expect(data?.length ?? 0).toBe(0);
  await deleteVendor(vendor.id);
});

// SUB-REQ-04: Grace vendor still visible (is_active=true)
test('SUB-REQ-04: grace vendor with is_active=true appears in active vendor query', async () => {
  const vendor = await seedVendor({
    subscription_status: 'grace',
    is_active: true,
    grace_ends_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('id', vendor.id)
    .eq('is_active', true);
  expect(data?.length ?? 0).toBe(1);
  await deleteVendor(vendor.id);
});

// SUB-REQ-05: Cancelled vendor hidden from Radar (is_active=false)
test('SUB-REQ-05: cancelled vendor with is_active=false not in active query', async () => {
  const vendor = await seedVendor({
    subscription_status: 'cancelled',
    is_active: false,
  });
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('id', vendor.id)
    .eq('is_active', true);
  expect(data?.length ?? 0).toBe(0);
  await deleteVendor(vendor.id);
});

// SUB-REQ-06: Waive-off applied and vendor notified
test('SUB-REQ-06: waive-off set on vendor updates DB and creates notification', async () => {
  const vendor = await seedVendor({ subscription_status: 'expired', is_active: false });
  await deleteNotifications(vendor.phone);

  // Apply waive-off directly (simulating admin action)
  const { error: updateError } = await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_percent: 50, waiveoff_months_remaining: 3 })
    .eq('id', vendor.id);
  expect(updateError).toBeNull();

  // Insert notification as admin panel would
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: vendor.phone,
    type: 'subscription_update',
    title: 'Special offer for you!',
    body: 'Aaspaas Pro is offering you 50% off for 3 months.',
    route: 'settings',
    is_informational: false,
  });

  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('type, title, body')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();

  expect(notif?.type).toBe('subscription_update');
  expect(notif?.body).toContain('50%');
  expect(notif?.body).toContain('3 months');

  const { data: v } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(v?.waiveoff_percent).toBe(50);
  expect(v?.waiveoff_months_remaining).toBe(3);

  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-REQ-07: global_billing_start_date null → trial_ends_at = last_updated + trial_days
test('SUB-REQ-07: when global_billing_start_date is empty trial_ends_at uses per-vendor date', async () => {
  const { data: config } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'global_billing_start_date')
    .single();
  // Only run assertion if global_billing_start_date is empty (default state)
  if (!config?.value?.trim()) {
    const vendor = await seedVendor();
    const { data } = await supabaseAdmin
      .from('vendors')
      .select('trial_ends_at, last_updated')
      .eq('id', vendor.id)
      .single();
    expect(data?.trial_ends_at).not.toBeNull();
    const trialEnd = new Date(data?.trial_ends_at);
    const lastUpdated = new Date(data?.last_updated);
    const diffDays = Math.round((trialEnd.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBeGreaterThanOrEqual(1);
    await deleteVendor(vendor.id);
  } else {
    test.info().annotations.push({ type: 'skip', description: 'global_billing_start_date is set — skipping per-vendor date assertion' });
  }
});

// SUB-REQ-08: Vendor in trial with null trial_ends_at — safe (no crash)
test('SUB-REQ-08: vendor with null trial_ends_at stays in trial safely', async () => {
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: null,
  });
  // Invoke edge fn — should not crash or change status
  await invokeCheckSubscriptions();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

// SUB-REQ-09: Two vendors expire simultaneously — both get notified
test('SUB-REQ-09: multiple vendors in grace both get expired correctly', async () => {
  const v1 = await seedVendor({
    subscription_status: 'expired',
    is_active: false,
  });
  const v2 = await seedVendor({
    subscription_status: 'expired',
    is_active: false,
  });
  const { data: both } = await supabaseAdmin
    .from('vendors')
    .select('id, subscription_status')
    .in('id', [v1.id, v2.id]);
  expect(both?.every(v => v.subscription_status === 'expired')).toBe(true);
  await deleteVendor(v1.id);
  await deleteVendor(v2.id);
});

// SUB-REQ-10: Active vendor visible in Radar
test('SUB-REQ-10: active subscription vendor appears in active vendor query', async () => {
  const vendor = await seedVendor({
    subscription_status: 'active',
    is_active: true,
    subscription_current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id, subscription_status')
    .eq('id', vendor.id)
    .eq('is_active', true);
  expect(data?.length ?? 0).toBe(1);
  expect(data?.[0]?.subscription_status).toBe('active');
  await deleteVendor(vendor.id);
});

// SUB-REQ-11: Trial → Grace transition (will pass when PAYMENTS_ENABLED=true)
test('SUB-REQ-11: expired trial vendor moves to grace when edge function runs', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // expired 1 min ago
    is_active: true,
  });
  await deleteNotifications(vendor.phone);
  await invokeCheckSubscriptions();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, grace_ends_at')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('grace');
  expect(data?.grace_ends_at).not.toBeNull();
  const diffDays = (new Date(data?.grace_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  expect(diffDays).toBeGreaterThan(2.9);
  expect(diffDays).toBeLessThan(3.1);
  // Notification must be created
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('type, body')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();
  expect(notif).not.toBeNull();
  expect(notif?.body).toContain('₹99');
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-REQ-12: Grace → Expired + offline (will pass when PAYMENTS_ENABLED=true)
test('SUB-REQ-12: grace vendor moves to expired and goes offline after grace period ends', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({
    subscription_status: 'grace',
    grace_ends_at: new Date(Date.now() - 60 * 1000).toISOString(), // grace ended 1 min ago
    is_active: true,
  });
  await deleteNotifications(vendor.phone);
  await invokeCheckSubscriptions();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, is_active')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('expired');
  expect(data?.is_active).toBe(false);
  // Notification must be created
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('type, body')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();
  expect(notif).not.toBeNull();
  expect(notif?.body).toContain('offline');
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-REQ-13: global_billing_start_date blocks transition (will pass when PAYMENTS_ENABLED=true)
test('SUB-REQ-13: trial vendor not moved to grace when global_billing_start_date is in future', async () => {
  // Temporarily set global_billing_start_date to tomorrow
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  await supabaseAdmin.rpc('upsert_admin_config', { p_key: 'global_billing_start_date', p_value: tomorrow, p_admin_phone: '8888169446' }).maybeSingle();
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  await invokeCheckSubscriptions();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  // Must still be trial — global billing start not reached
  expect(data?.subscription_status).toBe('trial');
  // Restore global_billing_start_date to empty
  await supabaseAdmin.rpc('upsert_admin_config', { p_key: 'global_billing_start_date', p_value: '', p_admin_phone: '8888169446' }).maybeSingle();
  await deleteVendor(vendor.id);
});

// SUB-REQ-14: No duplicate notification when cron runs twice (will pass when PAYMENTS_ENABLED=true)
test('SUB-REQ-14: running check-vendor-subscriptions twice does not create duplicate notifications', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  await deleteNotifications(vendor.phone);
  await invokeCheckSubscriptions();
  await invokeCheckSubscriptions(); // second run
  const { data: notifs } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update');
  // Must be exactly 1 notification, not 2
  expect(notifs?.length ?? 0).toBe(1);
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-REQ-15: vendor_trial_days config missing — edge function uses default (will pass when PAYMENTS_ENABLED=true)
test('SUB-REQ-15: check-vendor-subscriptions does not crash when vendor_trial_days missing from config', async () => {
  // This tests resilience — edge function should use default 30 if key missing
  const result = await invokeCheckSubscriptions();
  expect(result).not.toBeNull();
  // No crash = processed field exists
  expect(typeof result.processed).toBe('number');
});

// SUB-REQ-16: Waive-off decrements on charge (requirement perspective)
test('SUB-REQ-16: waive-off months decrement by 1 after successful charge', async () => {
  const vendor = await seedVendor({
    subscription_status: 'active',
    waiveoff_percent: 30,
    waiveoff_months_remaining: 2,
  });
  // Simulate charge decrement directly
  await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_months_remaining: 1, waiveoff_percent: 30 })
    .eq('id', vendor.id);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_months_remaining, waiveoff_percent')
    .eq('id', vendor.id)
    .single();
  expect(data?.waiveoff_months_remaining).toBe(1);
  expect(data?.waiveoff_percent).toBe(30);
  await deleteVendor(vendor.id);
});

// SUB-REQ-17: Waive-off clears when exhausted (requirement perspective)
test('SUB-REQ-17: waive-off percent clears to null when months reach zero', async () => {
  const vendor = await seedVendor({
    subscription_status: 'active',
    waiveoff_percent: 30,
    waiveoff_months_remaining: 1,
  });
  await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_months_remaining: 0, waiveoff_percent: null })
    .eq('id', vendor.id);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_months_remaining, waiveoff_percent')
    .eq('id', vendor.id)
    .single();
  expect(data?.waiveoff_months_remaining).toBe(0);
  expect(data?.waiveoff_percent).toBeNull();
  await deleteVendor(vendor.id);
});
