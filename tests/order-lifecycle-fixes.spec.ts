/**
 * Order lifecycle fixes:
 * - cancel voids unpaid bills (not paid)
 */
import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const createdRequestIds: string[] = [];
const createdBillIds: string[] = [];
let deliveryVendor: { id: string; phone: string };

async function seedRequest(opts: {
  vendorId: string;
  message: string;
  status?: string;
  userPhone?: string;
  deviceId?: string;
}) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: opts.vendorId,
      user_phone: opts.userPhone ?? TEST_CUSTOMER_PHONE,
      device_id: opts.deviceId ?? `device_ol_${T}`,
      message: opts.message,
      status: opts.status ?? 'sent',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

async function seedBill(
  requestId: string,
  vendorId: string,
  paymentStatus: 'unpaid' | 'paid' | 'pending',
) {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: requestId,
      vendor_id: vendorId,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 150,
      payment_mode: 'upi',
      payment_status: paymentStatus,
    })
    .select('id, payment_status')
    .single();
  if (error) throw error;
  createdBillIds.push(data.id);
  return data;
}

test.beforeAll(async () => {
  deliveryVendor = await createTestVendor({
    service_mode: 'delivery',
    shop_name: `OL-Delivery-${TEST_SESSION}`,
  });
  await createTestCustomer();
});

test.afterAll(async () => {
  if (createdBillIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('id', createdBillIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await cleanupTestVendors();
  await cleanupTestData();
});

test('OL-VOID-01: cancel_customer_order voids unpaid bill', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `OL-VOID-01 unpaid ${T}`,
    status: 'sent',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, 'unpaid');

  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error, error?.message).toBeNull();

  const { data: req } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', requestId)
    .single();
  expect(req?.status).toBe('cancelled');

  const { data: billRow } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('id', bill.id)
    .single();
  expect(billRow?.payment_status).toBe('void');
});

test('OL-VOID-02: cancel_customer_order does not void paid bill', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `OL-VOID-02 paid ${T}`,
    status: 'sent',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, 'paid');

  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error, error?.message).toBeNull();

  const { data: billRow } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('id', bill.id)
    .single();
  expect(billRow?.payment_status).toBe('paid');
});

test('OL-VOID-03: vendor_cancel_order voids unpaid bill', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `OL-VOID-03 vendor unpaid ${T}`,
    status: 'accepted',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, 'unpaid');

  const { error } = await supabaseAdmin.rpc('vendor_cancel_order', {
    p_request_id: requestId,
    p_vendor_id: deliveryVendor.id,
    p_vendor_phone: deliveryVendor.phone,
    p_cancel_reason: 'Closing early',
    p_cancel_appointment: false,
  });
  expect(error, error?.message).toBeNull();

  const { data: billRow } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('id', bill.id)
    .single();
  expect(billRow?.payment_status).toBe('void');
});

test('OL-VOID-04: vendor_cancel_order does not void paid bill', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `OL-VOID-04 vendor paid ${T}`,
    status: 'accepted',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, 'paid');

  const { error } = await supabaseAdmin.rpc('vendor_cancel_order', {
    p_request_id: requestId,
    p_vendor_id: deliveryVendor.id,
    p_vendor_phone: deliveryVendor.phone,
    p_cancel_reason: 'Closing early',
    p_cancel_appointment: false,
  });
  expect(error, error?.message).toBeNull();

  const { data: billRow } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('id', bill.id)
    .single();
  expect(billRow?.payment_status).toBe('paid');
});
