/**
 * Dismiss blocked while unpaid cash/UPI bill exists (customer + vendor RPCs).
 * Khata unpaid clears the cash/UPI gate (ledger / settle-dues stays separate).
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
import {
  billBlocksDismiss,
  resolveCustomerDismissSurfaceAction,
} from '../src/lib/dismissBillGate';
import { canShowCustomerCancelOrder } from '../src/lib/customerCancelPolicy';

const T = Date.now();
const createdRequestIds: string[] = [];
const createdBillIds: string[] = [];
let deliveryVendor: { id: string; phone: string };

async function seedRequest(opts: {
  vendorId: string;
  message: string;
  status?: string;
  delivery_slot?: string | null;
  delivery_slot_deadline?: string | null;
  service_mode?: string;
}) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: opts.vendorId,
      user_phone: TEST_CUSTOMER_PHONE,
      device_id: `device_dub_${T}`,
      message: opts.message,
      status: opts.status ?? 'fulfilled',
      delivery_slot: opts.delivery_slot ?? null,
      delivery_slot_deadline: opts.delivery_slot_deadline ?? null,
      service_mode: opts.service_mode ?? 'delivery',
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
  opts: { payment_status?: 'unpaid' | 'paid'; payment_mode?: 'cash' | 'upi' | 'khata' } = {},
) {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: requestId,
      vendor_id: vendorId,
      user_phone: TEST_CUSTOMER_PHONE,
      total_amount: 120,
      payment_mode: opts.payment_mode ?? 'upi',
      payment_status: opts.payment_status ?? 'unpaid',
    })
    .select('id, payment_status, payment_mode')
    .single();
  if (error) throw error;
  createdBillIds.push(data.id);
  return data;
}

test.beforeAll(async () => {
  deliveryVendor = await createTestVendor({
    service_mode: 'delivery',
    shop_name: `DUB-${TEST_SESSION}`,
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

test('DUB-01: dismiss_order rejects unpaid cash/UPI bill', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-01 ${T}`,
    status: 'fulfilled',
  });
  await seedBill(requestId, deliveryVendor.id, { payment_mode: 'upi', payment_status: 'unpaid' });

  const { error } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(error?.message ?? '').toMatch(/dismiss_blocked_unpaid_bill/);

  const { data: req } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', requestId)
    .single();
  expect(req?.status).toBe('fulfilled');
});

test('DUB-02: dismiss_order succeeds after bill marked paid', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-02 ${T}`,
    status: 'fulfilled',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, {
    payment_mode: 'cash',
    payment_status: 'unpaid',
  });

  const { error: unpaidErr } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(unpaidErr?.message ?? '').toMatch(/dismiss_blocked_unpaid_bill/);

  await supabaseAdmin
    .from('order_bills')
    .update({ payment_status: 'paid' })
    .eq('id', bill.id);

  const { error } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(error, error?.message).toBeNull();

  const { data: req } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', requestId)
    .single();
  expect(req?.status).toBe('done');
});

test('DUB-03: dismiss_order allowed after add_bill_to_khata (cash orphan cleared)', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-03 ${T}`,
    status: 'fulfilled',
  });
  const bill = await seedBill(requestId, deliveryVendor.id, {
    payment_mode: 'upi',
    payment_status: 'unpaid',
  });

  const { error: addErr } = await supabaseAdmin.rpc('add_bill_to_khata', {
    p_bill_id: bill.id,
    p_vendor_id: deliveryVendor.id,
    p_vendor_phone: deliveryVendor.phone,
  });
  expect(addErr, addErr?.message).toBeNull();

  const { data: updated } = await supabaseAdmin
    .from('order_bills')
    .select('payment_mode, payment_status')
    .eq('id', bill.id)
    .single();
  expect(updated?.payment_mode).toBe('khata');
  expect(updated?.payment_status).toBe('unpaid');
  expect(billBlocksDismiss(updated)).toBe(false);

  const { error } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(error, error?.message).toBeNull();
});

test('DUB-04: vendor_dismiss_requests rejects unpaid cash/UPI', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-04 ${T}`,
    status: 'fulfilled',
  });
  await seedBill(requestId, deliveryVendor.id, { payment_mode: 'cash', payment_status: 'unpaid' });

  const { error } = await supabaseAdmin.rpc('vendor_dismiss_requests', {
    p_vendor_id: deliveryVendor.id,
    p_vendor_phone: deliveryVendor.phone,
    p_request_ids: [requestId],
  });
  expect(error?.message ?? '').toMatch(/dismiss_blocked_unpaid_bill/);
});

test('DUB-05: vendor_dismiss_requests succeeds when bill paid', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-05 ${T}`,
    status: 'fulfilled',
  });
  await seedBill(requestId, deliveryVendor.id, { payment_mode: 'upi', payment_status: 'paid' });

  const { error } = await supabaseAdmin.rpc('vendor_dismiss_requests', {
    p_vendor_id: deliveryVendor.id,
    p_vendor_phone: deliveryVendor.phone,
    p_request_ids: [requestId],
  });
  expect(error, error?.message).toBeNull();

  const { data: req } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', requestId)
    .single();
  expect(req?.status).toBe('done');
});

test('DUB-06: three-way — cancel preferred while gate open; unpaid blocks dismiss when cancel closed', () => {
  const helpAccepted = {
    status: 'accepted',
    service_mode: 'help',
    vendor_started_at: null as string | null,
  };
  expect(canShowCustomerCancelOrder(helpAccepted)).toBe(true);
  expect(
    resolveCustomerDismissSurfaceAction({
      cancelAvailable: true,
      bill: { payment_status: 'unpaid', payment_mode: 'cash' },
    }),
  ).toBe('cancel');

  const asapAccepted = {
    status: 'accepted',
    service_mode: 'delivery',
    delivery_slot: 'asap',
    delivery_slot_deadline: new Date().toISOString(),
  };
  expect(canShowCustomerCancelOrder(asapAccepted)).toBe(false);
  expect(
    resolveCustomerDismissSurfaceAction({
      cancelAvailable: false,
      bill: { payment_status: 'unpaid', payment_mode: 'upi' },
    }),
  ).toBe('blocked_unpaid');
  expect(
    resolveCustomerDismissSurfaceAction({
      cancelAvailable: false,
      bill: { payment_status: 'paid', payment_mode: 'upi' },
    }),
  ).toBe('dismiss');
});

test('DUB-07: cancelled order with no unpaid cash/UPI bill can dismiss', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-07 ${T}`,
    status: 'cancelled',
  });

  const { error } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(error, error?.message).toBeNull();
});

test('DUB-08: ASAP accepted unpaid — cancel blocked; dismiss_order blocked', async () => {
  const requestId = await seedRequest({
    vendorId: deliveryVendor.id,
    message: `DUB-08 ${T}`,
    status: 'accepted',
    delivery_slot: 'asap',
    delivery_slot_deadline: new Date(Date.now() + 3600e3).toISOString(),
    service_mode: 'delivery',
  });
  await seedBill(requestId, deliveryVendor.id, { payment_mode: 'upi', payment_status: 'unpaid' });

  const { error: cancelErr } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
  });
  expect(cancelErr?.message ?? '').toMatch(/cancel_blocked_asap_accepted/);

  const { error: dismissErr } = await supabaseAdmin.rpc('dismiss_order', {
    p_request_id: requestId,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id: null,
    p_appointment_status: null,
  });
  expect(dismissErr?.message ?? '').toMatch(/dismiss_blocked_unpaid_bill/);
});
