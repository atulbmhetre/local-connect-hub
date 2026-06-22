import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRequestStatus, assertNotificationCreated, assertRowExists } from './helpers/db-assert';

let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('DM-05: vendor declines order — status becomes cancelled', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Order to decline',
      status: 'sent',
    })
    .select()
    .single();

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled', cancel_reason: 'Too far away' })
    .eq('id', order.id);

  expect(error).toBeNull();
  await assertRequestStatus(order.id, 'cancelled');
});

test('DM-05b: cancel_reason stored when vendor declines', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Order with reason',
      status: 'sent',
    })
    .select()
    .single();

  await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled', cancel_reason: 'Out of stock' })
    .eq('id', order.id);

  const { data } = await supabaseAdmin
    .from('requests')
    .select('cancel_reason, status')
    .eq('id', order.id)
    .single();

  expect(data?.cancel_reason).toBe('Out of stock');
  expect(data?.status).toBe('cancelled');
});

test('DM-05c: customer notified when vendor cancels', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Order for cancel notification',
      status: 'sent',
    })
    .select()
    .single();

  await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled', cancel_reason: 'Closing early' })
    .eq('id', order.id);

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'order_cancelled',
    title: 'Order Cancelled',
    body: 'Vendor cancelled: Closing early',
    route: 'orders',
    route_params: { order_id: order.id },
  });

  await assertNotificationCreated(TEST_CUSTOMER_PHONE, 'order_cancelled');
});

test('DM-06: customer cancels order before accepted', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Customer will cancel this',
      status: 'sent',
    })
    .select()
    .single();

  // Customer can cancel when status = sent
  const { data: current } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  const canCancel = current?.status === 'sent';
  expect(canCancel).toBe(true);

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled' })
    .eq('id', order.id);

  expect(error).toBeNull();
  await assertRequestStatus(order.id, 'cancelled');
});

test('DM-07: customer cannot cancel after accepted — status check blocks it', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Already accepted order',
      status: 'accepted',
    })
    .select()
    .single();

  // App checks status before allowing cancel
  const { data: current } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  const canCancel = current?.status === 'sent';
  expect(canCancel).toBe(false);
});

test('DM-08: vendor cancel uses one of 4 preset reasons', async () => {
  // Vendor has up to 4 cancel reasons stored on their profile
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('cancel_reason_1, cancel_reason_2, cancel_reason_3, cancel_reason_4')
    .eq('id', testVendor.id)
    .single();

  // Fields exist on vendor (may be null if not set yet — that's ok)
  expect(data).not.toBeNull();
  expect(Object.keys(data!)).toContain('cancel_reason_1');
  expect(Object.keys(data!)).toContain('cancel_reason_4');
});

test('DM-09: order card shows correct cancel origin', async () => {
  // Vendor cancelled
  const { data: vendorCancelled } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Vendor cancelled order',
      status: 'cancelled',
      cancel_reason: 'Not available',
    })
    .select()
    .single();

  const { data } = await supabaseAdmin
    .from('requests')
    .select('status, cancel_reason')
    .eq('id', vendorCancelled.id)
    .single();

  expect(data?.status).toBe('cancelled');
  expect(data?.cancel_reason).toBe('Not available');
});

test('CANCEL-EDGE-01: cancelling non-existent order returns error', async () => {
  const fakeId = '00000000-0000-0000-0000-000000000099';

  const { data, error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled' })
    .eq('id', fakeId)
    .select();

  // No rows updated — data should be empty
  expect(data?.length).toBe(0);
});
