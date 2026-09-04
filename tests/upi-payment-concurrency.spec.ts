/**
 * UPI payment RPC concurrency: dual claim overwrite + confirm/dispute race.
 * Expects FOR UPDATE + payment_status precondition on claim/confirm/dispute.
 */
import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

const T = Date.now();

/** 10-digit Indian-style phone for vendors_phone_format_check */
function phone(prefix: string, n: number): string {
  // prefix is 5 digits; append 5 from timestamp+n
  return `${prefix}${String(T + n).slice(-5)}`;
}

async function seedVendor(tag: string) {
  const p = phone('99008', tag.charCodeAt(0) + tag.length);
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `UPI Race ${tag}`,
      shop_name: `!UPI-RACE-${tag}-${T}`,
      phone: p,
      upi_id: `race-${tag}-${T}@upi`,
      service_mode: 'help',
      is_active: true,
      profile_status: 'complete',
      subscription_status: 'trial',
      trial_ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  return data as { id: string; phone: string };
}

async function seedClaimable(vendorId: string, userPhone: string, deviceId: string) {
  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      device_id: deviceId,
      user_phone: userPhone,
      vendor_id: vendorId,
      message: 'race order',
      status: 'accepted',
      service_mode: 'help',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  const { error: billErr } = await supabaseAdmin.from('order_bills').insert({
    request_id: req.id,
    vendor_id: vendorId,
    user_phone: userPhone,
    total_amount: 100,
    payment_mode: 'upi',
    payment_status: 'unpaid',
  });
  if (billErr) throw billErr;

  return req.id as string;
}

async function cleanup(vendorId: string, requestId: string, userPhone: string) {
  await supabaseAdmin.from('payment_dispute_events').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
  await supabaseAdmin.from('users').delete().eq('phone', userPhone);
  await supabaseAdmin.from('customer_payment_restrictions').delete().eq('identity_key', userPhone);
}

test('UPI-RACE-01: two simultaneous claims — only one wins', async () => {
  const vendor = await seedVendor('c1');
  const userPhone = phone('88008', 1);
  const deviceId = `dev_race_claim_${T}`;
  await supabaseAdmin.from('users').upsert({ phone: userPhone, trust_score: 80 }, { onConflict: 'phone' });
  const requestId = await seedClaimable(vendor.id, userPhone, deviceId);

  const utrA = '111111111111';
  const utrB = '222222222222';

  const [a, b] = await Promise.all([
    supabaseAdmin.rpc('claim_customer_payment', {
      p_request_id: requestId,
      p_payment_utr: utrA,
      p_device_id: deviceId,
      p_user_phone: userPhone,
    }),
    supabaseAdmin.rpc('claim_customer_payment', {
      p_request_id: requestId,
      p_payment_utr: utrB,
      p_device_id: deviceId,
      p_user_phone: userPhone,
    }),
  ]);

  const okCount = [a.error, b.error].filter((e) => e == null).length;
  const errMsgs = [a.error?.message, b.error?.message].filter(Boolean);

  expect(
    okCount,
    `expected exactly one claim success; ok=${okCount} errs=${JSON.stringify(errMsgs)}`,
  ).toBe(1);
  expect(errMsgs.some((m) => /payment_already_claimed|already_claimed|payment_not_claimable/i.test(String(m)))).toBe(
    true,
  );

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('payment_status, payment_utr')
    .eq('id', requestId)
    .single();
  expect(row?.payment_status).toBe('claimed');
  expect([utrA, utrB]).toContain(row?.payment_utr);

  await cleanup(vendor.id, requestId, userPhone);
});

test('UPI-RACE-02: simultaneous confirm and dispute — only one wins', async () => {
  const vendor = await seedVendor('cd');
  const userPhone = phone('88008', 2);
  const deviceId = `dev_race_cd_${T}`;
  await supabaseAdmin.from('users').upsert({ phone: userPhone, trust_score: 80 }, { onConflict: 'phone' });
  const requestId = await seedClaimable(vendor.id, userPhone, deviceId);

  await supabaseAdmin
    .from('requests')
    .update({
      payment_status: 'claimed',
      payment_utr: '333333333333',
      payment_claimed_at: new Date().toISOString(),
    })
    .eq('id', requestId);

  // Different device_id so self-confirmation block does not fire.
  const vendorDevice = `vendor_dev_${T}`;

  const [confirmRes, disputeRes] = await Promise.all([
    supabaseAdmin.rpc('confirm_upi_payment', {
      p_request_id: requestId,
      p_vendor_phone: vendor.phone,
      p_device_id: vendorDevice,
    }),
    supabaseAdmin.rpc('dispute_upi_payment', {
      p_request_id: requestId,
      p_vendor_phone: vendor.phone,
      p_device_id: vendorDevice,
    }),
  ]);

  const okCount = [confirmRes.error, disputeRes.error].filter((e) => e == null).length;
  const errMsgs = [confirmRes.error?.message, disputeRes.error?.message].filter(Boolean);

  expect(
    okCount,
    `expected exactly one of confirm/dispute to succeed; ok=${okCount} errs=${JSON.stringify(errMsgs)}`,
  ).toBe(1);
  expect(errMsgs.some((m) => /payment_not_claimed|payment_already_/i.test(String(m)))).toBe(true);

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(['confirmed', 'disputed']).toContain(row?.payment_status);

  await cleanup(vendor.id, requestId, userPhone);
});
