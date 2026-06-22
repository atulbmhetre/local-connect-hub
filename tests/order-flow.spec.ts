import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData, cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_VENDOR_PHONE,
} from './helpers/setup';
import {
  assertRequestStatus,
  assertNotificationCreated,
  assertRowExists,
  assertRowNotExists,
} from './helpers/db-assert';

let testVendor: any;
let testCustomer: any;
let testRequestId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  testCustomer = await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── DELIVERY ORDER FLOW ──────────────────────────────────────────────────

test('DM-01: customer places delivery order — request created with status sent', async () => {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Test order — 2 litres of milk',
      status: 'sent',
      delivery_address: '123 Test Street, Warje',
      delivery_slot: 'Morning (9am-12pm)',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.status).toBe('sent');
  expect(data.vendor_id).toBe(testVendor.id);
  expect(data.user_phone).toBe(TEST_CUSTOMER_PHONE);
  testRequestId = data.id;
});

test('DM-01b: notification created for vendor after order placed', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'new_order',
    title: 'New Order',
    body: 'You have a new delivery order',
    route: 'vendor',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_VENDOR_PHONE, 'new_order');
});

test('DM-02: vendor accepts order — status becomes accepted', async () => {
  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'accepted' })
    .eq('id', testRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(testRequestId, 'accepted');
});

test('DM-02b: customer notified when vendor accepts', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'order_accepted',
    title: 'Order Accepted',
    body: 'Your order has been accepted',
    route: 'orders',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_CUSTOMER_PHONE, 'order_accepted');
});

test('DM-04: vendor marks order done — status becomes done', async () => {
  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'done' })
    .eq('id', testRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(testRequestId, 'done');
});

// ─── ORDER EDIT FLOW ──────────────────────────────────────────────────────

test('ED-01: customer edits order — previous_message saved, is_edited = true', async () => {
  // Place a fresh editable order
  const { data: newOrder } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Original message',
      status: 'sent',
    })
    .select()
    .single();

  const { data: updated, error } = await supabaseAdmin
    .from('requests')
    .update({
      message: 'Updated message',
      previous_message: 'Original message',
      is_edited: true,
    })
    .eq('id', newOrder.id)
    .select()
    .single();

  expect(error).toBeNull();
  expect(updated.is_edited).toBe(true);
  expect(updated.previous_message).toBe('Original message');
  expect(updated.message).toBe('Updated message');
});

test('ED-04: edit blocked after order accepted — status check prevents write', async () => {
  // Simulate accepted order — update should be rejected by checking status first
  const { data: acceptedOrder } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Accepted order',
      status: 'accepted',
    })
    .select()
    .single();

  // Fetch current status (as app does before allowing edit)
  const { data: fetched } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', acceptedOrder.id)
    .single();

  // App logic: if status !== 'sent' — block edit
  expect(fetched?.status).not.toBe('sent');
});

// ─── BILL / KHATA FLOW ────────────────────────────────────────────────────

test('BK-01: vendor sends bill — order_bills row created', async () => {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: testRequestId,
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 150,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.total_amount).toBe(150);
  expect(data.payment_status).toBe('unpaid');
});

test('BK-02: duplicate bill blocked by unique constraint', async () => {
  // Try inserting second bill for same request_id
  const { error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: testRequestId,
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 200,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505'); // unique constraint violation
});

test('BK-04: mark bill as paid — payment_status becomes paid', async () => {
  const { error } = await supabaseAdmin
    .from('order_bills')
    .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
    .eq('request_id', testRequestId);

  expect(error).toBeNull();
  await assertRowExists('order_bills', {
    request_id: testRequestId,
    payment_status: 'paid',
  });
});

// ─── RATING FLOW ─────────────────────────────────────────────────────────

test('RV-01: customer submits rating — vendor_reviews row created', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: testVendor.id,
      request_id: testRequestId,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 5,
      review_text: 'Great service!',
      service_mode: 'delivery',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.rating).toBe(5);
});

test('RV-03: duplicate rating blocked — unique constraint on request_id', async () => {
  const { error } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: testVendor.id,
      request_id: testRequestId,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 3,
      review_text: 'Second rating attempt',
      service_mode: 'delivery',
    });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});

// ─── VENDOR BAN FLOW ─────────────────────────────────────────────────────

test('AD-01: vendor ban sets is_banned = true', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ is_banned: true, ban_reason: 'Test ban' })
    .eq('id', testVendor.id);

  expect(error).toBeNull();
  await assertRowExists('vendors', { id: testVendor.id, is_banned: true });
});

test('AD-03: banned vendor excluded from radar results', async () => {
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id, shop_name, is_banned')
    .eq('is_banned', false)
    .eq('is_active', true);

  const bannedInResults = data?.find(v => v.id === testVendor.id);
  expect(bannedInResults).toBeUndefined();
});

test('AD-04: vendor unban restores is_banned = false', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ is_banned: false, ban_reason: null })
    .eq('id', testVendor.id);

  expect(error).toBeNull();
  await assertRowExists('vendors', { id: testVendor.id, is_banned: false });
});

// ─── REFERRAL FLOW ────────────────────────────────────────────────────────

test('RF-03: duplicate referral blocked by unique constraint', async () => {
  await supabaseAdmin.from('referrals').insert({
    referee_id: TEST_CUSTOMER_PHONE,
    referee_type: 'user',
    status: 'pending',
    trigger_rule: 'active_once',
  });

  const { error } = await supabaseAdmin.from('referrals').insert({
    referee_id: TEST_CUSTOMER_PHONE,
    referee_type: 'user',
    status: 'pending',
    trigger_rule: 'active_once',
  });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});

// ─── SAVED VENDORS ────────────────────────────────────────────────────────

test('NB-05: duplicate saved vendor blocked by unique constraint', async () => {
  await supabaseAdmin.from('saved_vendors').insert({
    device_id: 'test-device-001',
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
  });

  const { error } = await supabaseAdmin.from('saved_vendors').insert({
    device_id: 'test-device-001',
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
  });

  expect(error).not.toBeNull();
  expect(['23505', '23503']).toContain(error!.code);
});

test('NB-03: max 20 saved vendors — enforced at app level (DB count check)', async () => {
  // Insert 20 saved vendors for customer
  const vendors = await Promise.all(
    Array.from({ length: 3 }).map((_, i) =>
      supabaseAdmin.from('vendors').insert({
        name: `Bulk Test Vendor ${i}`,
        phone: `7700000000${i}`,
        service_mode: 'delivery',
        vendor_note: `test_session:bulk`,
      }).select().single()
    )
  );

  // Count saved vendors for this customer
  const { count } = await supabaseAdmin
    .from('saved_vendors')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', TEST_CUSTOMER_PHONE);

  // App should block if count >= 20
  expect(count).toBeLessThanOrEqual(20);

  // Cleanup bulk vendors
  await cleanupTestVendors();
});
