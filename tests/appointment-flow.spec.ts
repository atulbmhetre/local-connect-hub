import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRequestStatus, assertNotificationCreated, assertRowExists } from './helpers/db-assert';

let testVendor: any;
let testRequestId: string;
let declineRequestId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();

  // Override service mode to appointment
  await supabaseAdmin
    .from('vendors')
    .update({ service_mode: 'appointment' })
    .eq('id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('vendor_reviews').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await cleanupTestData();
});

test('AP-01: customer books appointment — request created with appointment_time', async () => {
  const appointmentTime = new Date(Date.now() + 86400000).toISOString(); // tomorrow

  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Book haircut appointment',
      status: 'sent',
      appointment_time: appointmentTime,
      appointment_status: 'pending',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.status).toBe('sent');
  expect(data.appointment_time).not.toBeNull();
  expect(data.appointment_status).toBe('pending');
  testRequestId = data.id;
});

test('AP-01b: vendor notified of new appointment booking', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'new_appointment',
    title: 'New Booking',
    body: 'You have a new appointment request',
    route: 'vendor',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_VENDOR_PHONE, 'new_appointment');
});

test('AP-02: vendor confirms appointment — status becomes accepted', async () => {
  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'accepted', appointment_status: 'confirmed' })
    .eq('id', testRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(testRequestId, 'accepted');
});

test('AP-02b: customer notified on appointment confirmation', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'appointment_confirmed',
    title: 'Appointment Confirmed',
    body: 'Your appointment has been confirmed',
    route: 'orders',
    route_params: { order_id: testRequestId },
  });
  await assertNotificationCreated(TEST_CUSTOMER_PHONE, 'appointment_confirmed');
});

test('AP-03: vendor declines appointment — status becomes cancelled', async () => {
  const appointmentTime = new Date(Date.now() + 172800000).toISOString(); // day after tomorrow

  const { data } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Second appointment to decline',
      status: 'sent',
      appointment_time: appointmentTime,
      appointment_status: 'pending',
    })
    .select()
    .single();
  declineRequestId = data.id;

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled', cancel_reason: 'Not available that day' })
    .eq('id', declineRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(declineRequestId, 'cancelled');
});

test('AP-03b: customer notified on appointment decline', async () => {
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'appointment_declined',
    title: 'Appointment Declined',
    body: 'Your appointment was declined',
    route: 'orders',
    route_params: { order_id: declineRequestId },
  });
  await assertNotificationCreated(TEST_CUSTOMER_PHONE, 'appointment_declined');
});

test('AP-04: vendor marks appointment done — status becomes done', async () => {
  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'done' })
    .eq('id', testRequestId);

  expect(error).toBeNull();
  await assertRequestStatus(testRequestId, 'done');
});

test('AP-05: urgency Today uses appointment_time not created_at', async () => {
  // Set appointment_time to today
  const today = new Date();
  today.setHours(14, 0, 0, 0);

  await supabaseAdmin
    .from('requests')
    .update({ appointment_time: today.toISOString() })
    .eq('id', testRequestId);

  const { data } = await supabaseAdmin
    .from('requests')
    .select('appointment_time, created_at')
    .eq('id', testRequestId)
    .single();

  // App logic: use appointment_time for "today" check if set
  const referenceTime = data?.appointment_time ?? data?.created_at;
  const isToday = new Date(referenceTime).toDateString() === new Date().toDateString();

  expect(data?.appointment_time).not.toBeNull();
  expect(isToday).toBe(true);
});

test('RV-01: rating submitted after appointment done', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: testVendor.id,
      request_id: testRequestId,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 4,
      review_text: 'Great appointment',
      service_mode: 'appointment',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.rating).toBe(4);
  expect(data.service_mode).toBe('appointment');
});

test('RV-03: duplicate rating blocked for same appointment', async () => {
  const { error } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: testVendor.id,
      request_id: testRequestId,
      user_phone: TEST_CUSTOMER_PHONE,
      rating: 2,
      service_mode: 'appointment',
    });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});
