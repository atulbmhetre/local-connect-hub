/**
 * Phase 2 — anomaly screenshot gate + timing heuristic (prepaid agent-delivery UPI only).
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { MIN_PAYMENT_AWAY_MS } from '../src/lib/paymentResume';

const T = Date.now();
const CUSTOMER_PHONE = `88006${String(T).slice(-5)}`;
const DEVICE_ID = `device_pas_${T}`;
const UTR = '123456789012';

const L = {
  payNow: 'Pay Now',
  yesPaid: 'Yes',
  attachScreenshot: 'Attach screenshot',
  submitUtr: 'Submit Payment',
  awaitingVendor: 'Waiting for vendor to confirm payment',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99006${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createDeliveryVendor(tag: string): Promise<{ id: string; category_id: string }> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const upiId = `pas-${tag}-${T}@upi`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PAS Vendor ${tag}`,
      shop_name: `!PAS-${tag}-${T}`,
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
    .select('id, phone')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, { upi_id: upiId });
  createdVendorIds.push(vendor.id);
  return { id: vendor.id as string, category_id: category.id };
}

async function seedPaidBillHistory(vendorId: string, categoryId: string, amounts: number[]) {
  for (let i = 0; i < amounts.length; i++) {
    const { data: req, error } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: vendorId,
        user_phone: `hist-${i}-${CUSTOMER_PHONE}`,
        device_id: `hist-${i}-${DEVICE_ID}`,
        message: `hist-${i}`,
        status: 'fulfilled',
        service_mode: 'delivery',
        category_id: categoryId,
        delivery_fulfillment_method: 'agent',
        delivery_payment_timing: 'prepaid',
      })
      .select('id')
      .single();
    if (error) throw error;
    createdRequestIds.push(req.id);
    await supabaseAdmin.from('order_bills').insert({
      request_id: req.id,
      vendor_id: vendorId,
      user_phone: `hist-${i}-${CUSTOMER_PHONE}`,
      total_amount: amounts[i],
      payment_mode: i % 2 === 0 ? 'cash' : 'upi',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    });
  }
}

async function seedExceptionOrder(
  vendorId: string,
  categoryId: string,
  message: string,
  billTotal: number,
  paymentMode: 'upi' | 'cash' = 'upi',
) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      category_id: categoryId,
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const { error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
    p_customer_phone: CUSTOMER_PHONE,
    p_total: billTotal,
    p_payment_mode: paymentMode,
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PAS item', quantity: 1, unit_price: billTotal, unit: null }],
  });
  if (billError) throw new Error(`insert_bill failed: ${billError.message}`);
  return request.id as string;
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
}

async function openPaymentSheet(page: Page, message: string) {
  const card = page.getByTestId('order-card').filter({ hasText: message });
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.getByTestId('my-orders-pay-now-btn').click();
  await expect(page.getByTestId('payment-sheet')).toBeVisible({ timeout: 10000 });
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
  await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('PAS-01 — normal-value exception order: no screenshot section, claim succeeds', async ({
  page,
}) => {
  const vendor = await createDeliveryVendor('normal');
  await seedPaidBillHistory(vendor.id, vendor.category_id, [100, 100, 100, 100]);
  const msg = `PAS normal ${T}`;
  const requestId = await seedExceptionOrder(vendor.id, vendor.category_id, msg, 200);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  await openPaymentSheet(page, msg);

  const sheet = page.getByTestId('payment-sheet');
  await sheet.getByRole('button', { name: L.payNow }).click();
  await resumeAfterPay(page);
  await sheet.getByRole('button', { name: L.yesPaid }).click();
  await expect(sheet.getByTestId('payment-sheet-screenshot-section')).toHaveCount(0);

  await sheet.locator('#payment-sheet-utr').fill(UTR);
  await sheet.getByTestId('payment-sheet-submit-utr').click();

  await expect.poll(async () => {
    const { data } = await supabaseAdmin
      .from('requests')
      .select('payment_status, payment_screenshot_url')
      .eq('id', requestId)
      .single();
    return data?.payment_status;
  }).toBe('claimed');

  const { data: after } = await supabaseAdmin
    .from('requests')
    .select('payment_screenshot_url')
    .eq('id', requestId)
    .single();
  expect(after?.payment_screenshot_url).toBeNull();
});

test('PAS-02 — first-time vendor pairing: screenshot required and blocks claim until attached', async ({
  page,
}) => {
  const vendor = await createDeliveryVendor('first');
  const msg = `PAS first ${T}`;
  const requestId = await seedExceptionOrder(vendor.id, vendor.category_id, msg, 150);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  await openPaymentSheet(page, msg);

  const sheet = page.getByTestId('payment-sheet');
  await sheet.getByRole('button', { name: L.payNow }).click();
  await resumeAfterPay(page);
  await sheet.getByRole('button', { name: L.yesPaid }).click();
  await expect(sheet.getByTestId('payment-sheet-screenshot-section')).toBeVisible();

  await sheet.locator('#payment-sheet-utr').fill(UTR);
  await sheet.getByTestId('payment-sheet-submit-utr').click();

  const { data: blocked } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
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

  await expect(sheet.getByTestId('payment-sheet-screenshot-section').locator('.text-green-600')).toBeVisible({
    timeout: 15000,
  });

  await sheet.getByTestId('payment-sheet-submit-utr').click();

  await expect.poll(async () => {
    const { data } = await supabaseAdmin
      .from('requests')
      .select('payment_status, payment_screenshot_url')
      .eq('id', requestId)
      .single();
    return data?.payment_status;
  }).toBe('claimed');

  const { data: after } = await supabaseAdmin
    .from('requests')
    .select('payment_screenshot_url')
    .eq('id', requestId)
    .single();
  expect(after?.payment_screenshot_url).toMatch(/payment-proofs/);
});

test('PAS-03 — 3x+ history average: screenshot required', async ({ page }) => {
  const vendor = await createDeliveryVendor('spike');
  await seedPaidBillHistory(vendor.id, vendor.category_id, [100, 100, 100]);
  const msg = `PAS spike ${T}`;
  await seedExceptionOrder(vendor.id, vendor.category_id, msg, 350);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  await openPaymentSheet(page, msg);

  const sheet = page.getByTestId('payment-sheet');
  await sheet.getByRole('button', { name: L.payNow }).click();
  await resumeAfterPay(page);
  await sheet.getByRole('button', { name: L.yesPaid }).click();
  await expect(sheet.getByTestId('payment-sheet-screenshot-section')).toBeVisible();
});

test('PAS-04 — vendor-self delivery UPI still has no Pay Now (Phase 1 matrix unaffected)', async ({
  page,
}) => {
  const vendor = await createDeliveryVendor('vendor-self');
  const msg = `PAS vendor-self ${T}`;
  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message: msg,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      category_id: vendor.category_id,
      delivery_fulfillment_method: 'vendor',
      delivery_payment_timing: 'postpaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  createdRequestIds.push(req.id);
  const { error: billErr } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: req.id,
    p_vendor_id: vendor.id,
    p_customer_phone: CUSTOMER_PHONE,
    p_total: 500,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'x', quantity: 1, unit_price: 500, unit: null }],
  });
  if (billErr) throw billErr;

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  const card = page.getByTestId('order-card').filter({ hasText: msg });
  await expect(card.getByTestId('my-orders-pay-now-btn')).toHaveCount(0);
  await expect(card.getByTestId('my-orders-payment-awaiting-vendor')).toHaveText(L.awaitingVendor);
});
