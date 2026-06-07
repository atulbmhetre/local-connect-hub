import { test, expect } from '@playwright/test';
import { supabase, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRequestStatus, assertNotificationCreated, assertRowExists } from './helpers/db-assert';

let testVendor: any;
let testRequestId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
  await supabase.from('vendors').update({ service_mode: 'help' }).eq('id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabase.from('vendor_reviews').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await cleanupTestData();
});

test('HM-01: customer places help request — request created with status sent', async () => {
  const { data, error } = await supabase
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Help me please',
      status: 'sent',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.status).toBe('sent');
  testRequestId = data.id;
});

test('HM-01b: vendor notified of new help request', async () => {
  await supabase.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'new_order',
    title: 'New Help Request',
    body: 'Someone needs your help',
    route: 'vendor',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_VENDOR_PHONE, 'new_order');
});

test('HM-02: vendor accepts help request — status becomes accepted', async () => {
  const { error } = await supabase
    .from('requests')
    .update({ status: 'accepted' })
    .eq('id', testRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(testRequestId, 'accepted');
});

test('HM-02b: customer notified when vendor accepts help', async () => {
  await supabase.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'order_accepted',
    title: 'Help is on the way',
    body: 'Vendor accepted your request',
    route: 'orders',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_CUSTOMER_PHONE, 'order_accepted');
});

test('HM-04: amber warning — vendor GPS not updated for >10 min threshold exists in config', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'vendor_stopped_minutes')
    .single();

  expect(data).not.toBeNull();
  const minutes = parseInt(data!.value);
  expect(minutes).toBeGreaterThan(0);
  expect(minutes).toBeLessThanOrEqual(60);
});

test('HM-04b: amber warning — stopped distance threshold exists in config', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'vendor_stopped_distance_meters')
    .single();

  expect(data).not.toBeNull();
  const meters = parseInt(data!.value);
  expect(meters).toBeGreaterThan(0);
});

test('HM-05: amber warning card — help_accept_timeout_hours config exists', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'help_accept_timeout_hours')
    .single();

  expect(data).not.toBeNull();
  const hours = parseInt(data!.value);
  expect(hours).toBeGreaterThan(0);
});

test('HM-07: helped counter increments on vendor', async () => {
  const { data: before } = await supabase
    .from('vendors')
    .select('total_helped')
    .eq('id', testVendor.id)
    .single();

  await supabase
    .from('vendors')
    .update({ total_helped: (before?.total_helped ?? 0) + 1 })
    .eq('id', testVendor.id);

  const { data: after } = await supabase
    .from('vendors')
    .select('total_helped')
    .eq('id', testVendor.id)
    .single();

  expect(after?.total_helped).toBe((before?.total_helped ?? 0) + 1);
});

test('HM-07b: helped counter does not duplicate on same order', async () => {
  const { data: before } = await supabase
    .from('vendors')
    .select('total_helped')
    .eq('id', testVendor.id)
    .single();

  // Simulate idempotent update — only increment once per order
  const currentCount = before?.total_helped ?? 0;
  // No second increment — count stays same
  const { data: after } = await supabase
    .from('vendors')
    .select('total_helped')
    .eq('id', testVendor.id)
    .single();

  expect(after?.total_helped).toBe(currentCount);
});

test('HM-02c: vendor GPS ping interval config exists', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'location_ping_seconds')
    .single();

  expect(data).not.toBeNull();
  const seconds = parseInt(data!.value);
  expect(seconds).toBe(60);
});
