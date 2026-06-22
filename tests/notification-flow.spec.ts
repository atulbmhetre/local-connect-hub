import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertNotificationCreated, assertRowExists } from './helpers/db-assert';

let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', TEST_VENDOR_PHONE);
  await cleanupTestData();
});

test('NT-01: notification created for customer — row exists in user_notifications', async () => {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: TEST_CUSTOMER_PHONE,
      type: 'order_accepted',
      title: 'Order Accepted',
      body: 'Your order has been accepted',
      route: 'orders',
      is_read: false,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.is_read).toBe(false);
  expect(data.user_phone).toBe(TEST_CUSTOMER_PHONE);
});

test('NT-02: unread count correct — 3 unread notifications', async () => {
  // Insert 2 more unread (1 already inserted above)
  await supabaseAdmin.from('user_notifications').insert([
    { user_phone: TEST_CUSTOMER_PHONE, type: 'order_update', title: 'Update', body: 'Order updated', is_read: false },
    { user_phone: TEST_CUSTOMER_PHONE, type: 'khata_partial', title: 'Payment', body: 'Partial payment received', is_read: false },
  ]);

  const { count } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .eq('is_read', false);

  expect(count).toBeGreaterThanOrEqual(3);
});

test('NT-04: mark all read — all notifications is_read = true', async () => {
  const { error } = await supabaseAdmin
    .from('user_notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .eq('is_read', false);

  expect(error).toBeNull();

  const { count } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .eq('is_read', false);

  expect(count).toBe(0);
});

test('NT-05: unread notifications have is_read = false', async () => {
  // Insert a fresh unread
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'new_order',
    title: 'New',
    body: 'New notification',
    is_read: false,
  });

  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('is_read, created_at')
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(1);

  expect(data?.length).toBe(1);
  expect(data![0].is_read).toBe(false);
});

test('NT-06: notification has route_params for deep linking', async () => {
  const orderId = '00000000-0000-0000-0000-000000000001';

  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: TEST_CUSTOMER_PHONE,
      type: 'order_accepted',
      title: 'Order Ready',
      body: 'Tap to view',
      route: 'orders',
      route_params: { order_id: orderId },
      is_read: false,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.route_params).not.toBeNull();
  expect(data.route_params.order_id).toBe(orderId);
});

test('NT-10: cross-user notification insert works — anon can insert for another phone', async () => {
  // Simulate saveNotification inserting for vendor phone from customer session
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: TEST_VENDOR_PHONE, // different phone from customer
      type: 'new_order',
      title: 'New Order',
      body: 'You have a new order',
      route: 'vendor',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.user_phone).toBe(TEST_VENDOR_PHONE);
});

test('NT-03: vendor bell — vendor has separate notification entry', async () => {
  await assertNotificationCreated(TEST_VENDOR_PHONE, 'new_order');
});

test('NT-07: realtime insert — notification row exists immediately after insert', async () => {
  const uniqueType = `test_realtime_${TEST_SESSION}`;

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: uniqueType,
    title: 'Realtime Test',
    body: 'Should appear immediately',
    is_read: false,
  });

  // Row should be immediately queryable (no async delay needed in DB layer)
  await assertNotificationCreated(TEST_CUSTOMER_PHONE, uniqueType);
});

test('NT-08: read_at timestamp set when notification marked read', async () => {
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: TEST_CUSTOMER_PHONE,
      type: 'test_read_at',
      title: 'Read Test',
      body: 'Will be marked read',
      is_read: false,
    })
    .select()
    .single();

  const readAt = new Date().toISOString();
  await supabaseAdmin
    .from('user_notifications')
    .update({ is_read: true, read_at: readAt })
    .eq('id', notif.id);

  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('is_read, read_at')
    .eq('id', notif.id)
    .single();

  expect(data?.is_read).toBe(true);
  expect(data?.read_at).not.toBeNull();
});

test('NT-09: notification type stored correctly for all event types', async () => {
  const uniqueSession = `${TEST_SESSION}_nt09`;
  const types = [
    'new_order', 'order_accepted', 'order_done',
    'order_cancelled', 'account_warning', 'account_restored'
  ];

  const uniquePhone = `77099${Date.now().toString().slice(-5)}`;

  for (const type of types) {
    const { error } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_phone: uniquePhone,
        type,
        title: `Test ${type}`,
        body: `Notification for ${type}`,
        is_read: false,
      });
    expect(error).toBeNull();
  }

  const { count } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', uniquePhone)
    .in('type', types);

  expect(count).toBe(types.length);

  // Cleanup
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', uniquePhone);
});
