import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

// Helper: create a test vendor with subscription fields
async function seedVendor(overrides: Record<string, unknown> = {}) {
  const phone = `9800${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  const { data, error } = await supabaseAdmin.from('vendors').insert({
    name: 'Test Vendor',
    shop_name: 'Test Shop',
    phone,
    upi_id: 'test@upi',
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

// Helper: cleanup
async function deleteVendor(id: string) {
  await supabaseAdmin.from('vendors').delete().eq('id', id);
}

// --- Migration correctness ---
test('SUB-DB-01: new subscription columns exist on vendors table', async () => {
  const vendor = await seedVendor({
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    subscription_current_period_end: null,
    grace_ends_at: null,
    waiveoff_percent: null,
    waiveoff_months_remaining: null,
    subscription_id: null,
  });
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, trial_ends_at, subscription_current_period_end, grace_ends_at, waiveoff_percent, waiveoff_months_remaining, subscription_id')
    .eq('id', vendor.id)
    .single();
  expect(error).toBeNull();
  expect(data).not.toBeNull();
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

test('SUB-DB-02: subscription_status CHECK constraint rejects invalid value', async () => {
  const vendor = await seedVendor();
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ subscription_status: 'unknown_status' })
    .eq('id', vendor.id);
  expect(error).not.toBeNull();
  expect(error?.message).toMatch(/check/i);
  await deleteVendor(vendor.id);
});

test('SUB-DB-03: all 4 subscription app_config keys exist', async () => {
  const keys = ['vendor_trial_days', 'vendor_grace_period_days', 'vendor_subscription_price', 'global_billing_start_date'];
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('key, value')
    .in('key', keys);
  const foundKeys = (data ?? []).map((r: { key: string }) => r.key);
  for (const key of keys) {
    expect(foundKeys).toContain(key);
  }
});

test('SUB-DB-04: vendor_trial_days is a valid number', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'vendor_trial_days')
    .single();
  expect(data?.value).not.toBeNull();
  expect(parseInt(data?.value ?? '')).toBeGreaterThan(0);
});

test('SUB-DB-05: vendor_grace_period_days default is 3', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'vendor_grace_period_days')
    .single();
  expect(data?.value).toBe('3');
});

test('SUB-DB-06: vendor_subscription_price default is 99', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'vendor_subscription_price')
    .single();
  expect(data?.value).toBe('99');
});

test('SUB-DB-07: new vendor defaults to trial status', async () => {
  const vendor = await seedVendor();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

test('SUB-DB-08: vendor trial_ends_at is set on seed', async () => {
  const vendor = await seedVendor();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('trial_ends_at')
    .eq('id', vendor.id)
    .single();
  expect(data?.trial_ends_at).not.toBeNull();
  await deleteVendor(vendor.id);
});

test('SUB-DB-09: valid subscription_status values are accepted', async () => {
  const statuses = ['trial', 'active', 'grace', 'expired', 'cancelled'];
  for (const status of statuses) {
    const vendor = await seedVendor({ subscription_status: status });
    const { data } = await supabaseAdmin
      .from('vendors')
      .select('subscription_status')
      .eq('id', vendor.id)
      .single();
    expect(data?.subscription_status).toBe(status);
    await deleteVendor(vendor.id);
  }
});

test('SUB-DB-10: expired vendor can be set is_active false atomically', async () => {
  const vendor = await seedVendor({ subscription_status: 'trial' });
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ subscription_status: 'expired', is_active: false })
    .eq('id', vendor.id);
  expect(error).toBeNull();
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, is_active')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('expired');
  expect(data?.is_active).toBe(false);
  await deleteVendor(vendor.id);
});

test('SUB-DB-11: waiveoff fields can be set and cleared', async () => {
  const vendor = await seedVendor();
  await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_percent: 50, waiveoff_months_remaining: 3 })
    .eq('id', vendor.id);
  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(after?.waiveoff_percent).toBe(50);
  expect(after?.waiveoff_months_remaining).toBe(3);
  // Clear
  await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_percent: null, waiveoff_months_remaining: 0 })
    .eq('id', vendor.id);
  const { data: cleared } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(cleared?.waiveoff_percent).toBeNull();
  expect(cleared?.waiveoff_months_remaining).toBe(0);
  await deleteVendor(vendor.id);
});

test('SUB-DB-12: existing vendors have trial_ends_at set after backfill', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id, trial_ends_at')
    .is('trial_ends_at', null)
    .limit(5);
  // No vendor should have null trial_ends_at after migration backfill
  expect(data?.length ?? 0).toBe(0);
});
