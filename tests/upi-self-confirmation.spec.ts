/**
 * Same-device self-confirm/dispute block on confirm_upi_payment / dispute_upi_payment.
 * Does not prove vendor session; other-device spoof with vendor phone still succeeds.
 */
import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin } from './helpers/setup';

const T = Date.now();
const CUSTOMER_DEVICE = `usc-cust-${T}`;
const VENDOR_DEVICE = `usc-vend-${T}`;
const UTR = '123456789012';

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

function phone(prefix: string, tag: string): string {
  return `${prefix}${String(T).slice(-5)}${tag}`.slice(0, 10);
}

async function seedClaimedOrder(orderDeviceId: string, tag: string) {
  const vendorPhone = phone('9811', tag);
  const userPhone = phone('8811', tag);
  const { data: vendor, error: vErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'USC Vendor',
      shop_name: `!USC-${tag}-${T}`,
      phone: vendorPhone,
      upi_id: `usc-${tag}-${T}@upi`,
      service_mode: 'delivery',
      is_active: true,
      is_banned: false,
      profile_status: 'complete',
    })
    .select('id, phone')
    .single();
  if (vErr) throw new Error(`seedVendor: ${vErr.message}`);
  createdVendorIds.push(vendor.id);

  const { data: request, error: rErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: userPhone,
      device_id: orderDeviceId,
      message: `usc-${tag}-${T}`,
      status: 'fulfilled',
      payment_status: 'claimed',
      payment_utr: UTR,
      payment_claimed_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (rErr) throw new Error(`seedRequest: ${rErr.message}`);
  createdRequestIds.push(request.id);

  const { error: bErr } = await supabaseAdmin.from('order_bills').insert({
    request_id: request.id,
    vendor_id: vendor.id,
    user_phone: userPhone,
    total_amount: 150,
    payment_mode: 'upi',
    payment_status: 'unpaid',
  });
  if (bErr) throw new Error(`seedBill: ${bErr.message}`);

  return { vendor, requestId: request.id as string };
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('payment_dispute_events').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('USC-01: legitimate vendor confirm with different device_id succeeds', async () => {
  const { vendor, requestId } = await seedClaimedOrder(CUSTOMER_DEVICE, '1');

  const { error } = await supabase.rpc('confirm_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendor.phone,
    p_device_id: VENDOR_DEVICE,
  });
  expect(error).toBeNull();

  const { data: after } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(after?.payment_status).toBe('confirmed');

  const { data: bill } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('request_id', requestId)
    .single();
  expect(bill?.payment_status).toBe('paid');
});

test('USC-02: same-device self-confirm is rejected with self_confirmation_blocked', async () => {
  const { vendor, requestId } = await seedClaimedOrder(CUSTOMER_DEVICE, '2');

  const { error } = await supabase.rpc('confirm_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendor.phone,
    p_device_id: CUSTOMER_DEVICE,
  });
  expect(error).not.toBeNull();
  expect(error?.message ?? '').toMatch(/self_confirmation_blocked/);

  const { data: after } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(after?.payment_status).toBe('claimed');
});

test('USC-03: same-device self-dispute is rejected with self_confirmation_blocked', async () => {
  const { vendor, requestId } = await seedClaimedOrder(CUSTOMER_DEVICE, '3');

  const { error } = await supabase.rpc('dispute_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendor.phone,
    p_device_id: CUSTOMER_DEVICE,
  });
  expect(error).not.toBeNull();
  expect(error?.message ?? '').toMatch(/self_confirmation_blocked/);

  const { data: after } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(after?.payment_status).toBe('claimed');
});
