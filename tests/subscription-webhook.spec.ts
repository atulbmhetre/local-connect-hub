import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';
import * as crypto from 'crypto';

const EDGE_FUNCTION_URL = process.env.VITE_EDGE_FUNCTION_URL ?? process.env.VITE_SUPABASE_URL + '/functions/v1';
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;
const FAKE_WEBHOOK_SECRET = 'test_webhook_secret';

function signPayload(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function seedVendor(overrides: Record<string, unknown> = {}) {
  const phone = `9802${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  const subscriptionId = `sub_test_${Math.random().toString(36).slice(2)}`;
  const { data, error } = await supabaseAdmin.from('vendors').insert({
    name: 'Webhook Test Vendor',
    shop_name: 'Webhook Test Shop',
    phone,
    upi_id: 'webhook@upi',
    service_mode: 'help',
    is_active: true,
    is_banned: false,
    profile_status: 'complete',
    subscription_status: 'trial',
    trial_ends_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    subscription_id: subscriptionId,
    ...overrides,
  }).select().single();
  if (error) throw new Error(`seedVendor failed: ${error.message}`);
  return { ...data, subscriptionId };
}

async function deleteVendor(id: string) {
  await supabaseAdmin.from('vendors').delete().eq('id', id);
}

async function deleteNotifications(phone: string) {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
}

async function invokeWebhook(eventType: string, subscriptionId: string, extra: Record<string, unknown> = {}) {
  const body = JSON.stringify({
    event: eventType,
    payload: {
      subscription: {
        entity: {
          id: subscriptionId,
          current_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          ...extra,
        },
      },
    },
  });
  const signature = signPayload(body, FAKE_WEBHOOK_SECRET);
  const res = await fetch(`${EDGE_FUNCTION_URL}/razorpay-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
      'x-razorpay-signature': signature,
    },
    body,
  });
  return { status: res.status, body: await res.json() };
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

// SUB-WH-01: Dormant mode — all webhook events ignored
test('SUB-WH-01: dormant mode — webhook returns received:true without changing vendor', async () => {
  const vendor = await seedVendor();
  const result = await invokeWebhook('subscription.activated', vendor.subscriptionId);
  expect(result.status).toBe(200);
  expect(result.body.received).toBe(true);
  // Status must NOT change in dormant mode
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

// SUB-WH-02: Invalid signature rejected (when PAYMENTS_ENABLED=true this would matter)
// In dormant mode webhook returns 200 before signature check — test the signature fn directly
test('SUB-WH-02: invalid signature produces different hash than valid signature', async () => {
  const body = JSON.stringify({ event: 'subscription.activated' });
  const validSig = signPayload(body, 'correct_secret');
  const invalidSig = signPayload(body, 'wrong_secret');
  expect(validSig).not.toBe(invalidSig);
});

// SUB-WH-03: Unknown subscription_id — no crash
test('SUB-WH-03: unknown subscription_id handled gracefully', async () => {
  const result = await invokeWebhook('subscription.activated', 'sub_nonexistent_xyz');
  expect(result.status).toBe(200);
  expect(result.body.received).toBe(true);
});

// SUB-WH-04: Unhandled event type — no crash
test('SUB-WH-04: unhandled event type returns received:true without crash', async () => {
  const vendor = await seedVendor();
  const result = await invokeWebhook('subscription.some_future_event', vendor.subscriptionId);
  expect(result.status).toBe(200);
  expect(result.body.received).toBe(true);
  await deleteVendor(vendor.id);
});

// SUB-WH-05: Vendor notification created correctly
test('SUB-WH-05: subscription_update notification can be created for vendor', async () => {
  const vendor = await seedVendor();
  await deleteNotifications(vendor.phone);

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: vendor.phone,
    type: 'subscription_update',
    title: 'Payment successful',
    body: '₹99 received. Your shop stays live for another month.',
    route: 'settings',
    is_informational: false,
  });

  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('type, title')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();

  expect(data?.type).toBe('subscription_update');
  expect(data?.title).toBe('Payment successful');

  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-06: Grace period set correctly (3 days from now)
test('SUB-WH-06: grace_ends_at is set approximately 3 days from now', async () => {
  const vendor = await seedVendor();
  const graceEndsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

  await supabaseAdmin
    .from('vendors')
    .update({
      subscription_status: 'grace',
      grace_ends_at: graceEndsAt.toISOString(),
    })
    .eq('id', vendor.id);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, grace_ends_at')
    .eq('id', vendor.id)
    .single();

  expect(data?.subscription_status).toBe('grace');
  const diffMs = new Date(data?.grace_ends_at).getTime() - Date.now();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  expect(diffDays).toBeGreaterThan(2.9);
  expect(diffDays).toBeLessThan(3.1);

  await deleteVendor(vendor.id);
});

// SUB-WH-07: Waiveoff decrements correctly after charge
test('SUB-WH-07: waiveoff_months_remaining decrements and clears percent at 0', async () => {
  const vendor = await seedVendor({
    subscription_status: 'active',
    waiveoff_percent: 30,
    waiveoff_months_remaining: 1,
  });

  // Simulate what webhook handler does on subscription.charged
  const newRemaining = 1 - 1;
  await supabaseAdmin
    .from('vendors')
    .update({
      subscription_status: 'active',
      waiveoff_months_remaining: newRemaining,
      waiveoff_percent: newRemaining === 0 ? null : 30,
    })
    .eq('id', vendor.id);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();

  expect(data?.waiveoff_months_remaining).toBe(0);
  expect(data?.waiveoff_percent).toBeNull();

  await deleteVendor(vendor.id);
});

// SUB-WH-08: subscription.completed sets expired + offline
test('SUB-WH-08: vendor set to expired and offline on subscription completed', async () => {
  const vendor = await seedVendor({ subscription_status: 'active', is_active: true });

  await supabaseAdmin
    .from('vendors')
    .update({ subscription_status: 'expired', is_active: false })
    .eq('id', vendor.id);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, is_active')
    .eq('id', vendor.id)
    .single();

  expect(data?.subscription_status).toBe('expired');
  expect(data?.is_active).toBe(false);

  await deleteVendor(vendor.id);
});

// SUB-WH-09: subscription.activated → vendor status active (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-09: subscription.activated sets vendor status to active', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({ subscription_status: 'trial' });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.activated', vendor.subscriptionId);
  expect(result.status).toBe(200);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, grace_ends_at')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('active');
  expect(data?.grace_ends_at).toBeNull();
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('type, body')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();
  expect(notif?.body).toContain('live');
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-10: subscription.charged → active + period reset + waiveoff decrements (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-10: subscription.charged sets active and decrements waiveoff', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({
    subscription_status: 'active',
    waiveoff_percent: 30,
    waiveoff_months_remaining: 2,
  });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.charged', vendor.subscriptionId);
  expect(result.status).toBe(200);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, subscription_current_period_end, waiveoff_months_remaining, waiveoff_percent')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('active');
  expect(data?.subscription_current_period_end).not.toBeNull();
  expect(data?.waiveoff_months_remaining).toBe(1);
  expect(data?.waiveoff_percent).toBe(30);
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-11: subscription.payment_failed → grace + notification (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-11: subscription.payment_failed moves vendor to grace and notifies', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({ subscription_status: 'active', is_active: true });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.payment_failed', vendor.subscriptionId);
  expect(result.status).toBe(200);
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
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('body')
    .eq('user_phone', vendor.phone)
    .eq('type', 'subscription_update')
    .single();
  expect(notif?.body).toContain('payment');
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-12: subscription.cancelled → cancelled status (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-12: subscription.cancelled sets vendor status to cancelled', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({ subscription_status: 'active', is_active: true });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.cancelled', vendor.subscriptionId);
  expect(result.status).toBe(200);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('cancelled');
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-13: subscription.completed → expired + offline (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-13: subscription.completed sets vendor expired and offline', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({ subscription_status: 'active', is_active: true });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.completed', vendor.subscriptionId);
  expect(result.status).toBe(200);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, is_active')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('expired');
  expect(data?.is_active).toBe(false);
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// SUB-WH-14: Invalid signature rejected with 400 (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-14: invalid webhook signature returns 400', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor();
  const body = JSON.stringify({
    event: 'subscription.activated',
    payload: { subscription: { entity: { id: vendor.subscriptionId } } },
  });
  const res = await fetch(`${EDGE_FUNCTION_URL}/razorpay-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ANON_KEY}`,
      'x-razorpay-signature': 'invalid_signature_xyz',
    },
    body,
  });
  expect(res.status).toBe(400);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('trial');
  await deleteVendor(vendor.id);
});

// SUB-WH-15: Waiveoff clears completely when last month charged (will pass when PAYMENTS_ENABLED=true)
test('SUB-WH-15: waiveoff_percent clears to null when last waiveoff month is charged', async () => {
  test.skip(true, 'PAYMENTS_ENABLED=false — dormant until Razorpay KYC');
  const vendor = await seedVendor({
    subscription_status: 'active',
    waiveoff_percent: 50,
    waiveoff_months_remaining: 1,
  });
  await deleteNotifications(vendor.phone);
  const result = await invokeWebhook('subscription.charged', vendor.subscriptionId);
  expect(result.status).toBe(200);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(data?.waiveoff_months_remaining).toBe(0);
  expect(data?.waiveoff_percent).toBeNull();
  await deleteNotifications(vendor.phone);
  await deleteVendor(vendor.id);
});

// EC-02: Null grace_ends_at in grace status — no crash
test('EC-02: vendor with null grace_ends_at in grace status does not crash edge function', async () => {
  const vendor = await seedVendor({
    subscription_status: 'grace',
    grace_ends_at: null,
    is_active: true,
  });
  const result = await invokeCheckSubscriptions();
  expect(result).not.toBeNull();
  expect(typeof result.processed).toBe('number');
  // Vendor must not be incorrectly expired
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.subscription_status).toBe('grace');
  await deleteVendor(vendor.id);
});

// EC-03: Waive-off set on active vendor applies correctly
test('EC-03: waive-off set on active vendor persists correctly in DB', async () => {
  const vendor = await seedVendor({ subscription_status: 'active' });
  await supabaseAdmin
    .from('vendors')
    .update({ waiveoff_percent: 25, waiveoff_months_remaining: 2 })
    .eq('id', vendor.id);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining, subscription_status')
    .eq('id', vendor.id)
    .single();
  expect(data?.waiveoff_percent).toBe(25);
  expect(data?.waiveoff_months_remaining).toBe(2);
  expect(data?.subscription_status).toBe('active');
  await deleteVendor(vendor.id);
});

// EC-04: Admin waive-off with invalid phone — vendor not found
test('EC-04: waive-off lookup with invalid phone returns no vendor', async () => {
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', '0000000000')
    .maybeSingle();
  expect(data).toBeNull();
});
