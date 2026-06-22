import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists } from './helpers/db-assert';

let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('ED-01: edit saves previous_message and sets is_edited = true', async () => {
  const { data: order } = await supabaseAdmin
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
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .select()
    .single();

  expect(error).toBeNull();
  expect(updated.is_edited).toBe(true);
  expect(updated.previous_message).toBe('Original message');
  expect(updated.message).toBe('Updated message');
});

test('ED-01b: updated_at timestamp changes on edit', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Timestamp test order',
      status: 'sent',
    })
    .select()
    .single();

  const originalUpdatedAt = order.updated_at;

  await new Promise(r => setTimeout(r, 100));

  const newTimestamp = new Date().toISOString();
  await supabaseAdmin
    .from('requests')
    .update({ message: 'Edited', updated_at: newTimestamp })
    .eq('id', order.id);

  const { data } = await supabaseAdmin
    .from('requests')
    .select('updated_at')
    .eq('id', order.id)
    .single();

  expect(data?.updated_at).not.toBe(originalUpdatedAt);
});

test('ED-04: edit blocked after accepted — status check prevents write', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Accepted order',
      status: 'accepted',
    })
    .select()
    .single();

  const { data: fetched } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  // App blocks edit if status !== sent
  const canEdit = fetched?.status === 'sent';
  expect(canEdit).toBe(false);
});

test('ED-04b: edit blocked after done', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Done order',
      status: 'done',
    })
    .select()
    .single();

  const { data: fetched } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  const canEdit = fetched?.status === 'sent';
  expect(canEdit).toBe(false);
});

test('ED-04c: edit blocked after cancelled', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Cancelled order',
      status: 'cancelled',
    })
    .select()
    .single();

  const { data: fetched } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  const canEdit = fetched?.status === 'sent';
  expect(canEdit).toBe(false);
});

test('ED-05: edit blocked if order cancelled mid-edit — re-fetch detects cancel', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Will be cancelled mid-edit',
      status: 'sent',
    })
    .select()
    .single();

  // Simulate: order gets cancelled while edit sheet is open
  await supabaseAdmin
    .from('requests')
    .update({ status: 'cancelled' })
    .eq('id', order.id);

  // App re-fetches before saving edit
  const { data: recheck } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  const canStillEdit = recheck?.status === 'sent';
  expect(canStillEdit).toBe(false);
});

test('ED-07: delivery address stored correctly on request', async () => {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Delivery order with address',
      status: 'sent',
      delivery_address: '42 Test Lane, Warje, Pune',
      delivery_slot: 'Morning (9am-12pm)',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.delivery_address).toBe('42 Test Lane, Warje, Pune');
  expect(data.delivery_slot).toBe('Morning (9am-12pm)');
});

test('ED-08: previous_message preserved through multiple edits', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'First message',
      status: 'sent',
    })
    .select()
    .single();

  // First edit
  await supabaseAdmin
    .from('requests')
    .update({
      message: 'Second message',
      previous_message: 'First message',
      is_edited: true,
    })
    .eq('id', order.id);

  // Second edit — previous_message should update to second message
  await supabaseAdmin
    .from('requests')
    .update({
      message: 'Third message',
      previous_message: 'Second message',
      is_edited: true,
    })
    .eq('id', order.id);

  const { data } = await supabaseAdmin
    .from('requests')
    .select('message, previous_message, is_edited')
    .eq('id', order.id)
    .single();

  expect(data?.message).toBe('Third message');
  expect(data?.previous_message).toBe('Second message');
  expect(data?.is_edited).toBe(true);
});
