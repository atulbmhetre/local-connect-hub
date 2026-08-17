import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_VENDOR_PHONE,
  getActiveCategoryByServiceMode,
} from './helpers/setup';

const createdOrderIds: string[] = [];
const createdVendorIds: string[] = [];

test.beforeAll(async () => {
  await createTestCustomer();
});

test.afterAll(async () => {
  if (createdOrderIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdOrderIds);
    await supabaseAdmin.from('requests').delete().in('id', createdOrderIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  await cleanupTestVendors();
  await cleanupTestData();
});

async function insertOrder(patch: Record<string, unknown>) {
  const mode = String(patch.service_mode ?? 'help');
  const category = await getActiveCategoryByServiceMode(mode);
  const vendor = await createTestVendor({
    service_mode: mode,
    category_ids: [category.id],
    category_service_modes: [mode],
    availability_modes: [mode],
  });
  createdVendorIds.push(vendor.id);
  const { data: order, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      device_id: `device_cancel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      message: 'Cancel gate test',
      status: 'accepted',
      service_mode: mode,
      ...patch,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdOrderIds.push(order.id);
  return { order, vendor };
}

test('CAC-01 help accepted cancel succeeds before vendor_started_at', async () => {
  const { order } = await insertOrder({ service_mode: 'help', vendor_started_at: null });
  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: order.id,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error).toBeNull();
  const { data } = await supabaseAdmin.from('requests').select('status').eq('id', order.id).single();
  expect(data?.status).toBe('cancelled');
});

test('CAC-02 help accepted cancel blocked after vendor_started_at', async () => {
  const { order } = await insertOrder({
    service_mode: 'help',
    vendor_started_at: new Date().toISOString(),
  });
  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: order.id,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error?.message ?? '').toMatch(/cancel_blocked_vendor_started/);
});

test('CAC-03 delivery asap accepted cancel blocked', async () => {
  const { order } = await insertOrder({
    service_mode: 'delivery',
    delivery_slot: 'asap',
    delivery_slot_deadline: new Date(Date.now() + 2 * 3600e3).toISOString(),
  });
  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: order.id,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error?.message ?? '').toMatch(/cancel_blocked_asap_accepted/);
});

test('CAC-04 delivery morning cancel allowed before window start; voids unpaid bill', async () => {
  const deadline = new Date(Date.now() + 8 * 3600e3);
  const { order, vendor } = await insertOrder({
    service_mode: 'delivery',
    delivery_slot: 'morning',
    delivery_slot_deadline: deadline.toISOString(),
  });
  const { data: bill, error: billErr } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: order.id,
      vendor_id: vendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 50,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  expect(billErr).toBeNull();

  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: order.id,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error).toBeNull();

  const { data: billAfter } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('id', bill!.id)
    .single();
  expect(billAfter?.payment_status).toBe('void');
});

test('CAC-05 mark_vendor_order_started then help cancel blocked', async () => {
  const { order, vendor } = await insertOrder({ service_mode: 'help' });
  const { error: markErr } = await supabaseAdmin.rpc('mark_vendor_order_started', {
    p_request_id: order.id,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone ?? TEST_VENDOR_PHONE,
  });
  expect(markErr).toBeNull();
  const { error } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: order.id,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(error?.message ?? '').toMatch(/cancel_blocked_vendor_started/);
});
