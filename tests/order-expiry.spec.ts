import { test, expect } from '@playwright/test';
import {
  supabase,
  cleanupTestData, cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import {
  supabaseAdmin,
  createModeVendor,
  getDeliverySlotDeadline,
  invokeExpirePendingOrders,
  uniqueTestPhone,
  cleanupSession38Data,
  slotDeadlineAtLocal,
} from './helpers/session38';
import { assertNotificationCreated, assertRequestStatus } from './helpers/db-assert';

const CUSTOMER_PHONE = uniqueTestPhone('88002');
const DEVICE_ID = `device_expiry_${TEST_SESSION}`;
const HELP_VENDOR_PHONE = uniqueTestPhone('99001');
const DELIVERY_VENDOR_PHONE = uniqueTestPhone('99002');
const APPT_VENDOR_PHONE = uniqueTestPhone('99003');

let helpVendor: { id: string };
let deliveryVendor: { id: string };
let apptVendor: { id: string };

test.beforeAll(async () => {
  helpVendor = await createModeVendor('help', HELP_VENDOR_PHONE);
  deliveryVendor = await createModeVendor('delivery', DELIVERY_VENDOR_PHONE);
  apptVendor = await createModeVendor('appointment', APPT_VENDOR_PHONE);
  await supabaseAdmin.from('users').upsert(
    { phone: CUSTOMER_PHONE, total_orders: 0 },
    { onConflict: 'phone' },
  );
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupSession38Data([CUSTOMER_PHONE]);
  await cleanupTestData();
});

async function insertRequest(row: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('requests')
    .insert({
      device_id: DEVICE_ID,
      user_phone: CUSTOMER_PHONE,
      message: 'Expiry test order',
      status: 'sent',
      ...row,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data!;
}

test('EXP-01: help order older than 15 minutes expires after expire_pending_orders()', async () => {
  const order = await insertRequest({ vendor_id: helpVendor.id });
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  const { error: backdateError } = await supabaseAdmin
    .from('requests')
    .update({ created_at: twentyMinAgo })
    .eq('id', order.id);
  expect(backdateError).toBeNull();

  await invokeExpirePendingOrders();
  await assertRequestStatus(order.id, 'expired');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-02: delivery order with past delivery_slot_deadline expires', async () => {
  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    delivery_slot: 'evening',
    delivery_slot_deadline: pastDeadline,
  });

  await invokeExpirePendingOrders();
  await assertRequestStatus(order.id, 'expired');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-03: appointment order with past appointment_time expires both statuses', async () => {
  const pastAppt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const order = await insertRequest({
    vendor_id: apptVendor.id,
    appointment_time: pastAppt,
    appointment_status: 'pending',
  });

  await invokeExpirePendingOrders();

  const { data } = await supabase
    .from('requests')
    .select('status, appointment_status')
    .eq('id', order.id)
    .single();

  expect(data?.status).toBe('expired');
  expect(data?.appointment_status).toBe('expired');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-04: accepted order is not expired even if past deadline', async () => {
  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    status: 'accepted',
    delivery_slot: 'evening',
    delivery_slot_deadline: pastDeadline,
  });

  await invokeExpirePendingOrders();
  await assertRequestStatus(order.id, 'accepted');

  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-05: expire_pending_orders inserts order_expired notification per expired order', async () => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);

  const order = await insertRequest({ vendor_id: helpVendor.id });
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from('requests')
    .update({ created_at: twentyMinAgo })
    .eq('id', order.id);

  await invokeExpirePendingOrders();

  const notification = await assertNotificationCreated(CUSTOMER_PHONE, 'order_expired');
  expect(notification.related_id).toBe(order.id);
  expect(notification.route_params).toMatchObject({ order_id: order.id });

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-07: delivery seen order expires when slot deadline has passed', async () => {
  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    status: 'seen',
    delivery_slot: 'evening',
    delivery_slot_deadline: pastDeadline,
  });

  await invokeExpirePendingOrders();
  await assertRequestStatus(order.id, 'expired');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('EXP-06: delivery_slot_deadline matches slot rules on insert', async () => {
  const slots = ['asap', 'morning', 'afternoon', 'evening', 'tomorrow'] as const;
  const now = Date.now();

  for (const slot of slots) {
    const expected = getDeliverySlotDeadline(slot)!;
    const order = await insertRequest({
      vendor_id: deliveryVendor.id,
      delivery_slot: slot,
      delivery_slot_deadline: expected,
    });

    const { data } = await supabase
      .from('requests')
      .select('delivery_slot_deadline')
      .eq('id', order.id)
      .single();

    expect(new Date(data!.delivery_slot_deadline!).getTime()).toBe(new Date(expected).getTime());

    const stored = new Date(data!.delivery_slot_deadline!).getTime();
    if (slot === 'asap') {
      expect(stored).toBeGreaterThanOrEqual(now + 2 * 60 * 60 * 1000 - 5000);
      expect(stored).toBeLessThanOrEqual(now + 2 * 60 * 60 * 1000 + 5000);
    } else if (slot === 'morning') {
      expect(stored).toBe(slotDeadlineAtLocal(12).getTime());
    } else if (slot === 'afternoon') {
      expect(stored).toBe(slotDeadlineAtLocal(16).getTime());
    } else if (slot === 'evening') {
      expect(stored).toBe(slotDeadlineAtLocal(20).getTime());
    } else if (slot === 'tomorrow') {
      expect(stored).toBe(slotDeadlineAtLocal(20, 1).getTime());
    }

    await supabaseAdmin.from('requests').delete().eq('id', order.id);
  }
});
