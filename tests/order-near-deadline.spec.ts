import { test, expect } from '@playwright/test';
import {
  cleanupTestData, cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import {
  supabaseAdmin,
  createModeVendor,
  invokeWarnPendingOrdersNearDeadline,
  invokeWarnNearDeadlinePush,
  uniqueTestPhone,
  cleanupSession38Data,
} from './helpers/session38';
import { assertNotificationCreated } from './helpers/db-assert';

const CUSTOMER_PHONE = uniqueTestPhone('88003');
const DEVICE_ID = `device_near_deadline_${TEST_SESSION}`;
const DELIVERY_VENDOR_PHONE = uniqueTestPhone('99012');
const APPT_VENDOR_PHONE = uniqueTestPhone('99013');
const HELP_VENDOR_PHONE = uniqueTestPhone('99014');

let deliveryVendor: { id: string };
let apptVendor: { id: string };
let helpVendor: { id: string };

test.beforeAll(async () => {
  deliveryVendor = await createModeVendor('delivery', DELIVERY_VENDOR_PHONE);
  apptVendor = await createModeVendor('appointment', APPT_VENDOR_PHONE);
  helpVendor = await createModeVendor('help', HELP_VENDOR_PHONE);
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
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      device_id: DEVICE_ID,
      user_phone: CUSTOMER_PHONE,
      message: 'Near-deadline test order',
      status: 'sent',
      ...row,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data!;
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

test('ND-01: delivery sent order warns when slot deadline is within configured near window', async () => {
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    delivery_slot: 'evening',
    delivery_slot_deadline: minutesFromNow(45),
  });

  await invokeWarnPendingOrdersNearDeadline();

  const { data } = await supabaseAdmin
    .from('requests')
    .select('near_deadline_warned_at')
    .eq('id', order.id)
    .single();
  expect(data?.near_deadline_warned_at).toBeTruthy();

  const notification = await assertNotificationCreated(
    CUSTOMER_PHONE,
    'order_near_deadline_unseen',
  );
  expect(notification.related_id).toBe(order.id);

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-02: delivery seen order warns as unconfirmed near deadline', async () => {
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    status: 'seen',
    delivery_slot: 'evening',
    delivery_slot_deadline: minutesFromNow(30),
  });

  await invokeWarnPendingOrdersNearDeadline();

  await assertNotificationCreated(CUSTOMER_PHONE, 'order_near_deadline_unconfirmed');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-03: appointment booking seen but pending warns near appointment time', async () => {
  const order = await insertRequest({
    vendor_id: apptVendor.id,
    status: 'seen',
    appointment_time: minutesFromNow(40),
    appointment_status: 'pending',
  });

  await invokeWarnPendingOrdersNearDeadline();

  await assertNotificationCreated(CUSTOMER_PHONE, 'order_near_deadline_unconfirmed');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-04: accepted order is not near-deadline warned', async () => {
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    status: 'accepted',
    delivery_slot: 'evening',
    delivery_slot_deadline: minutesFromNow(30),
  });

  await invokeWarnPendingOrdersNearDeadline();

  const { data } = await supabaseAdmin
    .from('requests')
    .select('near_deadline_warned_at')
    .eq('id', order.id)
    .single();
  expect(data?.near_deadline_warned_at).toBeNull();

  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-05: one near-deadline warning per customer per vendor even with multiple orders', async () => {
  const deadline = minutesFromNow(45);
  const orderA = await insertRequest({
    vendor_id: deliveryVendor.id,
    delivery_slot: 'evening',
    delivery_slot_deadline: deadline,
  });
  const orderB = await insertRequest({
    vendor_id: deliveryVendor.id,
    delivery_slot: 'evening',
    delivery_slot_deadline: deadline,
  });

  await invokeWarnPendingOrdersNearDeadline();
  await invokeWarnPendingOrdersNearDeadline();

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE)
    .eq('type', 'order_near_deadline_unseen');

  expect(notifications?.length).toBe(1);

  const { data: warnedOrders } = await supabaseAdmin
    .from('requests')
    .select('near_deadline_warned_at')
    .in('id', [orderA.id, orderB.id]);
  expect(warnedOrders?.every((row) => row.near_deadline_warned_at)).toBe(true);

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().in('id', [orderA.id, orderB.id]);
});

test('ND-06: help sent order warns near accept timeout', async () => {
  const order = await insertRequest({ vendor_id: helpVendor.id });
  const elevenMinAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from('requests')
    .update({ created_at: elevenMinAgo })
    .eq('id', order.id);

  await invokeWarnPendingOrdersNearDeadline();

  await assertNotificationCreated(CUSTOMER_PHONE, 'order_near_deadline_unseen');

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

async function assertPushHopReachedNotifyUser(opts: {
  orderId: string;
  phone: string;
  expectedType: string;
}) {
  const notification = await assertNotificationCreated(opts.phone, opts.expectedType);
  expect(notification.related_id).toBe(opts.orderId);

  const deviceId = `device_nd_push_${opts.orderId.slice(0, 8)}`;
  await supabaseAdmin.from('user_devices').upsert({
    user_phone: opts.phone,
    device_id: deviceId,
    fcm_token: `nd-push-dummy-${opts.orderId}`,
    is_current: true,
  });

  const since = new Date(Date.now() - 15_000).toISOString();
  const result = await invokeWarnNearDeadlinePush();
  expect(typeof result.pushed).toBe('number');

  const { data: logs, error: logError } = await supabaseAdmin
    .from('fcm_delivery_log')
    .select('notification_type, success_count, failure_count, raw_response, created_at')
    .eq('target_phone', opts.phone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  expect(logError, logError?.message).toBeNull();
  expect(logs?.length, 'notify-user never logged — push hop did not run').toBeGreaterThan(0);

  const { data: requestRow } = await supabaseAdmin
    .from('requests')
    .select('near_deadline_push_sent, near_deadline_warned_at')
    .eq('id', opts.orderId)
    .single();
  expect(requestRow?.near_deadline_warned_at).toBeTruthy();
  // Dummy token cannot deliver; stamp stays false so cron retries.
  if (!logs?.some((row) => Number(row.success_count) > 0)) {
    expect(requestRow?.near_deadline_push_sent).toBe(false);
  }

  await supabaseAdmin.from('user_devices').delete().eq('device_id', deviceId);
}

test('ND-PUSH-HELP: warn SQL + warn-near-deadline edge reaches notify-user', async () => {
  const order = await insertRequest({ vendor_id: helpVendor.id });
  await supabaseAdmin
    .from('requests')
    .update({ created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
    .eq('id', order.id);

  await invokeWarnPendingOrdersNearDeadline();
  await assertPushHopReachedNotifyUser({
    orderId: order.id,
    phone: CUSTOMER_PHONE,
    expectedType: 'order_near_deadline_unseen',
  });

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-PUSH-DELIVERY: warn SQL + warn-near-deadline edge reaches notify-user', async () => {
  const order = await insertRequest({
    vendor_id: deliveryVendor.id,
    delivery_slot: 'evening',
    delivery_slot_deadline: minutesFromNow(45),
  });

  await invokeWarnPendingOrdersNearDeadline();
  await assertPushHopReachedNotifyUser({
    orderId: order.id,
    phone: CUSTOMER_PHONE,
    expectedType: 'order_near_deadline_unseen',
  });

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('ND-PUSH-APPOINTMENT: warn SQL + warn-near-deadline edge reaches notify-user', async () => {
  const order = await insertRequest({
    vendor_id: apptVendor.id,
    status: 'seen',
    appointment_time: minutesFromNow(40),
    appointment_status: 'pending',
  });

  await invokeWarnPendingOrdersNearDeadline();
  await assertPushHopReachedNotifyUser({
    orderId: order.id,
    phone: CUSTOMER_PHONE,
    expectedType: 'order_near_deadline_unconfirmed',
  });

  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});
