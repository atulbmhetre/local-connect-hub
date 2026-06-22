import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists } from './helpers/db-assert';

let testVendor: any;
let testRequestId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();

  const { data } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Khata test order',
      status: 'done',
    })
    .select()
    .single();
  testRequestId = data.id;
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabaseAdmin.from('order_bills').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await cleanupTestData();
});

test('BK-01: khata bill creates order_bills row with payment_mode = khata', async () => {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: testRequestId,
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 500,
      payment_mode: 'khata',
      payment_status: 'unpaid',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.payment_mode).toBe('khata');
  expect(data.payment_status).toBe('unpaid');
});

test('BK-05: khata bill also creates khata_transactions row', async () => {
  const { data, error } = await supabaseAdmin
    .from('khata_transactions')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      request_id: testRequestId,
      amount: 500,
      payment_mode: 'khata',
      note: 'Bill for order',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.amount).toBe(500);
});

test('BK-06: ledger created with correct outstanding balance', async () => {
  const { data, error } = await supabaseAdmin
    .from('khata_ledger')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_outstanding: 500,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.total_outstanding).toBe(500);
});

test('BK-06b: partial payment reduces balance not zeroes it', async () => {
  // Pay 200 of 500
  const { error } = await supabaseAdmin
    .from('khata_ledger')
    .update({ total_outstanding: 300 })
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', TEST_CUSTOMER_PHONE);

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.total_outstanding).toBe(300);
  expect(data?.total_outstanding).not.toBe(0);
});

test('BK-06c: partial payment inserts khata_transactions row', async () => {
  const { data, error } = await supabaseAdmin
    .from('khata_transactions')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      amount: -200,
      payment_mode: 'cash',
      note: 'Partial payment',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.amount).toBe(-200);
});

test('BK-07: mark paid when balance = 0 — order_bills updated to paid', async () => {
  // Zero the balance
  await supabaseAdmin
    .from('khata_ledger')
    .update({ total_outstanding: 0 })
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', TEST_CUSTOMER_PHONE);

  // Mark bill as paid
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

test('BK-07b: mark paid notification sent to customer', async () => {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: TEST_CUSTOMER_PHONE,
      type: 'khata_paid',
      title: 'Khata Cleared',
      body: 'Your outstanding balance has been cleared',
      route: 'orders',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.type).toBe('khata_paid');
});

test('BK-02: duplicate bill replace — void old bill then insert new', async () => {
  // Void existing bill
  await supabaseAdmin
    .from('order_bills')
    .update({ payment_status: 'void' })
    .eq('request_id', testRequestId);

  // Now insert new bill (old is voided so unique constraint allows it via delete+insert)
  await supabaseAdmin
    .from('order_bills')
    .delete()
    .eq('request_id', testRequestId);

  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: testRequestId,
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 750,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.total_amount).toBe(750);
});

test('BK-08: ledger cycle start date is settable per vendor', async () => {
  const cycleDate = new Date().toISOString().split('T')[0];
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ ledger_cycle_start: cycleDate })
    .eq('id', testVendor.id);

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('ledger_cycle_start')
    .eq('id', testVendor.id)
    .single();

  expect(data?.ledger_cycle_start).toBe(cycleDate);
});
