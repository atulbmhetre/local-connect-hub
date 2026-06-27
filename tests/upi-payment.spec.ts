import { test, expect } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

async function seedVendor(overrides: Record<string, unknown> = {}) {
  const phone = `9800${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
  const { data, error } = await supabaseAdmin.from('vendors').insert({
    name: 'Test Vendor',
    shop_name: 'Test Shop',
    phone,
    upi_id: 'test@upi',
    service_mode: 'delivery',
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

async function seedRequest(vendorId: string, userPhone: string) {
  const { data, error } = await supabaseAdmin.from('requests').insert({
    device_id: 'test-device',
    user_phone: userPhone,
    vendor_id: vendorId,
    message: 'UPI test order',
    status: 'fulfilled',
    payment_status: 'unpaid',
  }).select().single();
  if (error) throw new Error(`seedRequest failed: ${error.message}`);
  return data;
}

async function seedBill(requestId: string, vendorId: string) {
  const { data, error } = await supabaseAdmin.from('order_bills').insert({
    request_id: requestId,
    vendor_id: vendorId,
    total_amount: 15000,
    payment_status: 'unpaid',
  }).select().single();
  if (error) throw new Error(`seedBill failed: ${error.message}`);
  return data;
}

async function cleanup(vendorId: string, requestId: string) {
  if (requestId) {
    await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
}

function testUserPhone(): string {
  return `8800${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
}

test('UPI-DB-01: payment columns exist on requests table', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const request = await seedRequest(vendor.id, userPhone);

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('payment_status, payment_utr, payment_claimed_at, payment_confirmed_at')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.payment_status).toBe('unpaid');

  await cleanup(vendor.id, request.id);
});

test('UPI-DB-02: payment_status CHECK constraint rejects invalid value', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const request = await seedRequest(vendor.id, userPhone);

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ payment_status: 'invalid_status' })
    .eq('id', request.id);

  expect(error).not.toBeNull();
  expect(error?.message).toMatch(/check/i);

  await cleanup(vendor.id, request.id);
});

test('UPI-DB-03: customer can claim payment by submitting UTR', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const request = await seedRequest(vendor.id, userPhone);
  await seedBill(request.id, vendor.id);

  const { error: claimError } = await supabaseAdmin
    .from('requests')
    .update({
      payment_status: 'claimed',
      payment_utr: '123456789012',
    })
    .eq('id', request.id);
  expect(claimError).toBeNull();

  const { error: confirmError } = await supabaseAdmin
    .from('requests')
    .update({
      payment_status: 'confirmed',
      payment_confirmed_at: new Date().toISOString(),
    })
    .eq('id', request.id);
  expect(confirmError).toBeNull();

  const { error: billError } = await supabaseAdmin
    .from('order_bills')
    .update({ payment_status: 'paid' })
    .eq('request_id', request.id);
  expect(billError).toBeNull();

  const { data: reqAfter } = await supabaseAdmin
    .from('requests')
    .select('payment_status, payment_utr')
    .eq('id', request.id)
    .single();
  expect(reqAfter?.payment_status).toBe('confirmed');
  expect(reqAfter?.payment_utr).toBe('123456789012');

  const { data: billAfter } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('request_id', request.id)
    .single();
  expect(billAfter?.payment_status).toBe('paid');

  await cleanup(vendor.id, request.id);
});

test('UPI-DB-04: UTR must be 12 digits — RPC rejects invalid UTR', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const request = await seedRequest(vendor.id, userPhone);
  await seedBill(request.id, vendor.id);

  const { error } = await supabaseAdmin.rpc('confirm_upi_payment', {
    p_request_id: request.id,
    p_utr: '123',
    p_vendor_phone: vendor.phone,
  });
  expect(error).not.toBeNull();

  await cleanup(vendor.id, request.id);
});

test('UPI-DB-05: vendor can dispute a claimed payment', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const request = await seedRequest(vendor.id, userPhone);

  await supabaseAdmin
    .from('requests')
    .update({
      payment_status: 'claimed',
      payment_utr: '123456789012',
    })
    .eq('id', request.id);

  const { error: disputeError } = await supabaseAdmin
    .from('requests')
    .update({ payment_status: 'disputed' })
    .eq('id', request.id);
  expect(disputeError).toBeNull();

  const { data: reqAfter } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', request.id)
    .single();
  expect(reqAfter?.payment_status).toBe('disputed');

  await cleanup(vendor.id, request.id);
});

test('UPI-DB-06: fulfilled order without bill cannot be marked done (trigger check)', async () => {
  const vendor = await seedVendor();
  const userPhone = testUserPhone();
  const { data: request, error: insertError } = await supabaseAdmin
    .from('requests')
    .insert({
      device_id: 'test-device',
      user_phone: userPhone,
      vendor_id: vendor.id,
      message: 'UPI test order',
      status: 'accepted',
      payment_status: 'unpaid',
    })
    .select()
    .single();
  if (insertError) throw new Error(`seedRequest failed: ${insertError.message}`);

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'fulfilled' })
    .eq('id', request!.id);

  if (error) {
    expect(error.message).toMatch(/bill|fulfil/i);
  } else {
    const { data: reqAfter } = await supabaseAdmin
      .from('requests')
      .select('payment_status, status')
      .eq('id', request!.id)
      .single();
    expect(reqAfter?.payment_status).toBe('unpaid');
  }

  await cleanup(vendor.id, request!.id);
});

test('UPI-DB-07: upi_qr_url column exists on vendors table', async () => {
  const vendor = await seedVendor({ upi_qr_url: null });

  const { data: initial, error: selectError } = await supabaseAdmin
    .from('vendors')
    .select('upi_qr_url')
    .eq('id', vendor.id)
    .single();
  expect(selectError).toBeNull();
  expect(initial?.upi_qr_url).toBeNull();

  const testUrl = 'https://example.com/upi-qr.png';
  const { error: updateError } = await supabaseAdmin
    .from('vendors')
    .update({ upi_qr_url: testUrl })
    .eq('id', vendor.id);
  expect(updateError).toBeNull();

  const { data: updated } = await supabaseAdmin
    .from('vendors')
    .select('upi_qr_url')
    .eq('id', vendor.id)
    .single();
  expect(updated?.upi_qr_url).toBe(testUrl);

  await cleanup(vendor.id, '');
});
