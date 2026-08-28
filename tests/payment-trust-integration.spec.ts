/**
 * Payment-trust integration — continuous journey across Phases 2, 5c, and 6d.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { MIN_PAYMENT_AWAY_MS } from '../src/lib/paymentResume';

const T = Date.now();
const UTR_ANOMALY = '123456789012';
const UTR_DISPUTE_A = '123456789013';
const UTR_DISPUTE_B = '123456789014';
const UTR_BLOCKING = '123456789015';

const L = {
  payNow: 'Pay Now',
  yesPaid: 'Yes',
  cashOnly:
    'Online payment is temporarily unavailable on your account. Please pay cash to the vendor.',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function customerPhone(): string {
  return `88005${String(T).slice(-5)}`;
}

const PHONE = customerPhone();
const DEVICE_ID = `device_pti_${T}`;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99005${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createDeliveryVendor(tag: string, withPaidHistory = false) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const upiId = `pti-${tag}-${T}@upi`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PTI Vendor ${tag}`,
      shop_name: `!PTI-${tag}-${T}`,
      phone,
      upi_id: upiId,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, {
    serves_at_customer_place: true,
    upi_id: upiId,
  });
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .eq('vendor_id', vendor.id);
  createdVendorIds.push(vendor.id);

  if (withPaidHistory) {
    for (let i = 0; i < 3; i++) {
      const histPhone = `hist_${i}_${vendor.id.slice(0, 8)}`;
      const { data: req } = await supabaseAdmin
        .from('requests')
        .insert({
          vendor_id: vendor.id,
          user_phone: histPhone,
          device_id: `hist_${i}_${DEVICE_ID}`,
          message: `hist-${i}`,
          status: 'fulfilled',
          service_mode: 'delivery',
          category_id: category.id,
          delivery_fulfillment_method: 'agent',
          delivery_payment_timing: 'prepaid',
        })
        .select('id')
        .single();
      createdRequestIds.push(req!.id);
      await supabaseAdmin.from('order_bills').insert({
        request_id: req!.id,
        vendor_id: vendor.id,
        user_phone: histPhone,
        total_amount: 100,
        payment_mode: 'upi',
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      });
    }
  }

  return { ...vendor, category_id: category.id };
}

async function placeDeliveryOrder(vendorId: string, message: string) {
  const { data, error } = await supabase.rpc('create_customer_request', {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendorId,
    p_message: message,
    p_user_phone: PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: 'delivery',
    p_delivery_address: 'PTI integration test address',
    p_delivery_slot: 'tomorrow',
  });
  if (error) throw new Error(`create_customer_request failed: ${error.message}`);
  createdRequestIds.push(data as string);
  return data as string;
}

async function fulfillWithUpiBill(vendorId: string, requestId: string, total: number) {
  const { error: acceptErr } = await supabaseAdmin
    .from('requests')
    .update({ status: 'accepted' })
    .eq('id', requestId);
  if (acceptErr) throw new Error(`accept order failed: ${acceptErr.message}`);

  const { error } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendorId,
    p_customer_phone: PHONE,
    p_total: total,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PTI item', quantity: 1, unit_price: total, unit: null }],
  });
  if (error) throw new Error(`insert_bill failed: ${error.message}`);
}

async function claimAndDispute(
  requestId: string,
  vendorPhone: string,
  utr: string,
) {
  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: utr,
    p_device_id: DEVICE_ID,
    p_user_phone: PHONE,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const { error: disputeErr } = await supabase.rpc('dispute_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendorPhone,
  });
  if (disputeErr) throw new Error(`dispute failed: ${disputeErr.message}`);
}

async function seedAgedBlockingBill(vendorId: string, message: string) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const { data: billId, error: billErr } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
    p_customer_phone: PHONE,
    p_total: 300,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PTI block item', quantity: 1, unit_price: 300, unit: null }],
  });
  if (billErr) throw billErr;
  created.billIds?.push?.(billId);

  const aged = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from('order_bills').update({ created_at: aged }).eq('id', billId);
  return { requestId: request.id as string, billId: billId as string };
}

const created = { billIds: [] as string[] };

async function blockStatus() {
  const { data, error } = await supabase.rpc('get_customer_payment_block_status', {
    p_user_phone: PHONE,
    p_device_id: DEVICE_ID,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

async function restrictionStatus() {
  const { data, error } = await supabase.rpc('get_customer_payment_restriction_status', {
    p_user_phone: PHONE,
    p_device_id: DEVICE_ID,
  });
  if (error) throw error;
  return Boolean(data?.[0]?.is_restricted);
}

async function resumeAfterPay(page: Page) {
  await page.waitForTimeout(MIN_PAYMENT_AWAY_MS + 100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.beforeAll(async () => {
  createdCustomerPhones.push(PHONE);
  await supabaseAdmin.from('users').upsert({ phone: PHONE, trust_score: 75 }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('payment_dispute_events').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await supabaseAdmin.from('customer_payment_restrictions').delete().eq('identity_key', PHONE);
  if (createdCustomerPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('PTI-01 — continuous journey: anomaly claim → disputes → 6d block + 5c restriction interaction', async ({
  page,
}) => {
  test.setTimeout(300_000);

  const anomalyVendor = await createDeliveryVendor('anomaly', false);
  const disputeVendorA = await createDeliveryVendor('dispute-a', true);
  const disputeVendorB = await createDeliveryVendor('dispute-b', true);
  const blockingVendor = await createDeliveryVendor('block', true);
  const targetVendor = await createDeliveryVendor('target', true);

  const msgAnomaly = `PTI anomaly order ${T}`;
  const msgDisputeA = `PTI dispute-a ${T}`;
  const msgDisputeB = `PTI dispute-b ${T}`;
  const msgBlocking = `PTI blocking bill ${T}`;
  const msgCashOnlyUi = `PTI cash-only ui ${T}`;

  // Step 1 — place prepaid agent delivery order (Phase 0 snapshot via create_customer_request)
  const anomalyRequestId = await placeDeliveryOrder(anomalyVendor.id, msgAnomaly);
  await supabaseAdmin
    .from('requests')
    .update({ delivery_slot: 'morning' })
    .eq('id', anomalyRequestId);
  await fulfillWithUpiBill(anomalyVendor.id, anomalyRequestId, 200);

  const { data: anomalyReq } = await supabaseAdmin
    .from('requests')
    .select('delivery_fulfillment_method, delivery_payment_timing, service_mode')
    .eq('id', anomalyRequestId)
    .single();
  expect(anomalyReq?.service_mode).toBe('delivery');
  expect(anomalyReq?.delivery_fulfillment_method).toBe('agent');
  expect(anomalyReq?.delivery_payment_timing).toBe('prepaid');

  // Step 2 — Phase 2: first-time pairing requires screenshot; complete self-declare in browser
  const { data: reqBeforeClaim } = await supabase.rpc('get_payment_claim_requirements', {
    p_request_id: anomalyRequestId,
    p_device_id: DEVICE_ID,
    p_user_phone: PHONE,
  });
  expect(reqBeforeClaim?.requires_screenshot).toBe(true);

  await loginAsCustomer(page, PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const anomalyCard = page.getByTestId('order-card').filter({ hasText: msgAnomaly });
  await anomalyCard.getByTestId('my-orders-pay-now-btn').click();
  const sheet = page.getByTestId('payment-sheet');
  await expect(sheet).toBeVisible({ timeout: 10000 });
  await sheet.getByRole('button', { name: L.payNow }).click();
  await resumeAfterPay(page);
  await sheet.getByRole('button', { name: L.yesPaid }).click();
  await expect(sheet.getByTestId('payment-sheet-screenshot-section')).toBeVisible();
  await sheet.locator('#payment-sheet-utr').fill(UTR_ANOMALY);
  await sheet.getByTestId('payment-sheet-submit-utr').click();

  const { data: blocked } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', anomalyRequestId)
    .single();
  expect(blocked?.payment_status).toBe('unpaid');

  await sheet.locator('#payment-sheet-screenshot').setInputFiles({
    name: 'proof.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  await expect(
    sheet.getByTestId('payment-sheet-screenshot-section').locator('.text-green-600'),
  ).toBeVisible({ timeout: 15000 });

  await sheet.getByTestId('payment-sheet-submit-utr').click();

  await expect.poll(async () => {
    const { data } = await supabaseAdmin
      .from('requests')
      .select('payment_status')
      .eq('id', anomalyRequestId)
      .single();
    return data?.payment_status;
  }).toBe('claimed');

  // Step 3 — Phase 5c: two vendor disputes on separate orders
  const reqA = await placeDeliveryOrder(disputeVendorA.id, msgDisputeA);
  await fulfillWithUpiBill(disputeVendorA.id, reqA, 150);
  await claimAndDispute(reqA, disputeVendorA.phone, UTR_DISPUTE_A);
  expect(await restrictionStatus()).toBe(false);

  const reqB = await placeDeliveryOrder(disputeVendorB.id, msgDisputeB);
  await fulfillWithUpiBill(disputeVendorB.id, reqB, 150);
  await claimAndDispute(reqB, disputeVendorB.phone, UTR_DISPUTE_B);
  expect(await restrictionStatus()).toBe(true);

  // Step 4a — open order for 5c cash-only UI (must exist before 6d block gates new orders)
  const cashOnlyRequestId = await placeDeliveryOrder(disputeVendorA.id, msgCashOnlyUi);
  await fulfillWithUpiBill(disputeVendorA.id, cashOnlyRequestId, 120);

  // Step 4b — Phase 6d: aged unpaid blocking bill
  const { requestId: blockingRequestId } = await seedAgedBlockingBill(blockingVendor.id, msgBlocking);

  expect(await blockStatus()).toMatchObject({ is_blocked: true, amount: 300 });
  expect(await restrictionStatus()).toBe(true);

  const { data: blockedOrderId, error: blockErr } = await supabase.rpc('create_customer_request', {
    p_device_id: DEVICE_ID,
    p_vendor_id: targetVendor.id,
    p_message: `PTI blocked attempt ${T}`,
    p_user_phone: PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: 'delivery',
    p_delivery_address: 'blocked attempt',
    p_delivery_slot: 'tomorrow',
  });
  expect(blockedOrderId).toBeNull();
  expect(blockErr?.message ?? '').toContain('customer_payment_block');

  // Step 5 — 5c cash-only messaging on a separate unpaid UPI order
  await page.reload();
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  const cashOnlyCard = page.getByTestId('order-card').filter({ hasText: msgCashOnlyUi });
  await expect(cashOnlyCard).toBeVisible({ timeout: 15000 });
  await expect(cashOnlyCard.getByTestId('my-orders-pay-now-btn')).toHaveCount(0);
  await expect(cashOnlyCard.getByTestId('my-orders-payment-cash-only')).toHaveText(L.cashOnly);

  // Step 6 — "I've Paid" on 6d blocking bill while 5c still active
  const { error: ivePaidErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: blockingRequestId,
    p_payment_utr: UTR_BLOCKING,
    p_device_id: DEVICE_ID,
    p_user_phone: PHONE,
  });

  // Documented interaction: 5c restriction gate runs before claim can clear 6d block.
  expect(ivePaidErr?.message ?? '').toContain('payment_self_declare_restricted');
  expect(await blockStatus()).toMatchObject({ is_blocked: true });
  expect(await restrictionStatus()).toBe(true);

  const { data: afterFailedClaim } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', blockingRequestId)
    .single();
  expect(afterFailedClaim?.payment_status).toBe('unpaid');
});
