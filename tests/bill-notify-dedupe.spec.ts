/**
 * Bill notify dedupe: notify_order_bill_trigger must produce exactly one inbox row
 * and one FCM delivery log entry per bill (BillSheet cash path + ledger khata path).
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  vendorPhoneById,
  createTestVendor,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import { uniqueTestPhone } from './helpers/session38';

const T = Date.now();
const FCM_TYPE = 'user-bill';
const ITERATIONS = 5;
const STABILITY_POLLS = 12;
const STABILITY_INTERVAL_MS = 250;

type BillPath = 'billsheet_cash' | 'ledger_khata';

function customerPhone(iter: number, path: BillPath): string {
  const suffix = path === 'billsheet_cash' ? '01' : '02';
  return uniqueTestPhone(`881${suffix}${iter}`);
}

async function seedRequest(
  vendorId: string,
  userPhone: string,
  status: 'accepted' | 'fulfilled',
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `bill-notify-dedupe-${T}`,
      status,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function registerCustomerDevice(userPhone: string, deviceId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('user_devices').insert({
    user_phone: userPhone,
    device_id: deviceId,
    fcm_token: `bill_dedupe_${deviceId}`,
    is_current: true,
  });
  if (error) throw error;
}

async function countBillInboxRows(userPhone: string, orderId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', userPhone)
    .eq('type', 'bill')
    .contains('route_params', { order_id: orderId });
  if (error) throw error;
  return count ?? 0;
}

async function countFcmLogs(userPhone: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('fcm_delivery_log')
    .select('id', { count: 'exact', head: true })
    .eq('target_phone', userPhone)
    .eq('notification_type', FCM_TYPE);
  if (error) throw error;
  return count ?? 0;
}

async function insertBill(path: BillPath, opts: {
  requestId: string;
  vendorId: string;
  customerPhone: string;
  total: number;
}): Promise<string> {
  const paymentMode = path === 'ledger_khata' ? 'khata' : 'cash';
  const { data, error } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: opts.requestId,
    p_vendor_id: opts.vendorId,
      p_vendor_phone: await vendorPhoneById(opts.vendorId),
    p_customer_phone: opts.customerPhone,
    p_total: opts.total,
    p_payment_mode: paymentMode,
    p_payment_status: 'unpaid',
    p_notes: path === 'ledger_khata' ? 'Ledger khata entry' : null,
    p_items: [
      {
        name: path === 'ledger_khata' ? 'Khata item' : 'Bill item',
        quantity: 1,
        unit_price: opts.total,
        unit: null,
      },
    ],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  return data as string;
}

async function assertStableSingleInbox(userPhone: string, orderId: string): Promise<void> {
  let sawOne = false;
  for (let i = 0; i < STABILITY_POLLS; i += 1) {
    const count = await countBillInboxRows(userPhone, orderId);
    expect(count, `poll ${i + 1}: inbox row count must not exceed 1`).toBeLessThanOrEqual(1);
    if (count === 1) sawOne = true;
    await new Promise((r) => setTimeout(r, STABILITY_INTERVAL_MS));
  }
  const finalCount = await countBillInboxRows(userPhone, orderId);
  expect(finalCount, 'exactly one inbox row for this bill').toBe(1);
  expect(sawOne, 'inbox row appeared within stability window').toBe(true);
}

async function waitForFcmLogDelta(
  userPhone: string,
  baseline: number,
  timeoutMs = 15000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await countFcmLogs(userPhone);
    if (count >= baseline + 1) return count;
    await new Promise((r) => setTimeout(r, 200));
  }
  return countFcmLogs(userPhone);
}

async function runBillPathIteration(
  path: BillPath,
  iter: number,
  vendor: { id: string; phone: string },
): Promise<void> {
  const customer = customerPhone(iter, path);
  const deviceId = `bill_dedupe_${path}_${T}_${iter}`;
  const orderStatus = path === 'ledger_khata' ? 'fulfilled' : 'accepted';
  const total = path === 'ledger_khata' ? 180 + iter : 150 + iter;

  await supabaseAdmin.from('users').upsert({ phone: customer, trust_score: 70 }, { onConflict: 'phone' });
  await registerCustomerDevice(customer, deviceId);

  const fcmBaseline = await countFcmLogs(customer);
  const requestId = await seedRequest(vendor.id, customer, orderStatus);

  const billId = await insertBill(path, {
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total,
  });
  expect(billId).toBeTruthy();

  await assertStableSingleInbox(customer, requestId);

  const fcmAfter = await waitForFcmLogDelta(customer, fcmBaseline);
  expect(fcmAfter - fcmBaseline, 'exactly one new FCM log row for this bill').toBe(1);

  // Second stability pass on FCM — no duplicate log row from delayed pg_net.
  await new Promise((r) => setTimeout(r, STABILITY_INTERVAL_MS * 4));
  const fcmFinal = await countFcmLogs(customer);
  expect(fcmFinal - fcmBaseline, 'FCM log count stable at +1').toBe(1);

  await supabaseAdmin.from('order_items').delete().eq('bill_id', billId);
  await supabaseAdmin.from('order_bills').delete().eq('id', billId);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', customer);
  await supabaseAdmin.from('fcm_delivery_log').delete().eq('target_phone', customer);
  await supabaseAdmin.from('user_devices').delete().eq('device_id', deviceId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
  await supabaseAdmin.from('users').delete().eq('phone', customer);
}

test.describe('bill notify dedupe (trigger skip_inbox)', () => {
  let vendor: { id: string; phone: string };

  test.beforeAll(async () => {
    vendor = await createTestVendor({
      shop_name: `BillNotifyDedupe-${TEST_SESSION}`,
      service_mode: 'delivery',
    });
  });

  test.afterAll(async () => {
    await cleanupTestVendors();
  });

  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    test(`BN-DEDUPE-CASH-${iter + 1}/${ITERATIONS} — BillSheet path: one inbox + one FCM log`, async () => {
      await runBillPathIteration('billsheet_cash', iter, vendor);
    });

    test(`BN-DEDUPE-KHATA-${iter + 1}/${ITERATIONS} — ledger path: one inbox + one FCM log`, async () => {
      await runBillPathIteration('ledger_khata', iter, vendor);
    });
  }
});
