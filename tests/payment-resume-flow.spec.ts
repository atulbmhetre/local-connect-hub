import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

/**
 * Payment resume prompt tests (PRF-*).
 *
 * LIMITATION: PaymentSheet listens to Capacitor App.addListener('appStateChange')
 * on native, and document.visibilitychange on web. Playwright cannot drive
 * appStateChange, so these tests simulate "returning to the app" by mocking
 * document.visibilityState as 'visible' and dispatching a visibilitychange
 * event — matching the web-fallback path in PaymentSheet.tsx.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88004${String(T).slice(-5)}`;
const DEVICE_ID = `device_prf_${T}`;

const L = {
  payNow: 'Pay Now',
  didYouPay: 'Did you complete the payment?',
  yesPaid: 'Yes',
  noPaid: 'No',
  enterUtr: 'Enter UTR / Transaction ID',
  submitUtr: 'Submit Payment',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99004${String(T + vendorPhoneSeq).slice(-5)}`;
}

type VendorRow = { id: string; phone: string; shop_name: string };

async function stubUpiDeepLinkOpen(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __upiOpens: string[] }).__upiOpens = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __upiOpens: string[] }).__upiOpens.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  });
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function createVendor(tag: string): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PRF Vendor ${tag}`,
      shop_name: `!PRF-${tag}-${T}`,
      phone,
      upi_id: `prf-vendor-${T}@upi`,
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
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedFulfilledOrderWithUnpaidBill(vendorId: string, message: string) {
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
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const billTotal = 250;
  const { error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
    p_customer_phone: CUSTOMER_PHONE,
    p_total: billTotal,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PRF item', quantity: 1, unit_price: billTotal, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);

  return { requestId: request.id, billTotal };
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 15000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

function paymentSheet(page: Page): Locator {
  return page.getByTestId('payment-sheet');
}

async function openPaymentSheetFromOrder(page: Page, message: string) {
  const card = orderCard(page, message);
  await card.getByTestId('my-orders-pay-now-btn').click();
  await expect(paymentSheet(page)).toBeVisible({ timeout: 10000 });
}

async function tapPayNowInSheet(page: Page) {
  await paymentSheet(page).getByRole('button', { name: L.payNow }).click();
}

/**
 * Web-only resume simulation — see file-top LIMITATION comment.
 * Waits past the minimum away-duration gate before dispatching visibilitychange.
 */
async function simulateAppResume(page: Page) {
  await page.waitForTimeout(5100);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function cleanupRequest(requestId: string) {
  await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
}

async function cleanupVendor(vendorId: string) {
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
}

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

test('PRF-01 — Pay Now → simulated resume → Yes → UTR field appears', async ({ page }) => {
  const vendor = await createVendor('01');
  const msg = `PRF-01 resume yes ${T}`;
  const { requestId } = await seedFulfilledOrderWithUnpaidBill(vendor.id, msg);

  try {
    await stubUpiDeepLinkOpen(page);
    await seedCustomer();
    await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
    await gotoMyOrders(page);
    await openPaymentSheetFromOrder(page, msg);

    const sheet = paymentSheet(page);
    await tapPayNowInSheet(page);
    await simulateAppResume(page);

    await expect(sheet.getByText(L.didYouPay)).toBeVisible({ timeout: 5000 });
    await expect(sheet.getByRole('button', { name: L.yesPaid })).toBeVisible();
    await expect(sheet.getByRole('button', { name: L.noPaid })).toBeVisible();

    await sheet.getByRole('button', { name: L.yesPaid }).click();

    await expect(sheet.locator('#payment-sheet-utr')).toBeVisible();
    await expect(sheet.getByLabel(L.enterUtr)).toBeVisible();
    await expect(sheet.getByRole('button', { name: L.submitUtr })).toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).not.toBeVisible();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});

test('PRF-02 — Pay Now → simulated resume → No → resets to Pay Now', async ({ page }) => {
  const vendor = await createVendor('02');
  const msg = `PRF-02 resume no ${T}`;
  const { requestId } = await seedFulfilledOrderWithUnpaidBill(vendor.id, msg);

  try {
    await stubUpiDeepLinkOpen(page);
    await seedCustomer();
    await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
    await gotoMyOrders(page);
    await openPaymentSheetFromOrder(page, msg);

    const sheet = paymentSheet(page);
    await tapPayNowInSheet(page);
    await simulateAppResume(page);

    await expect(sheet.getByText(L.didYouPay)).toBeVisible({ timeout: 5000 });
    await sheet.getByRole('button', { name: L.noPaid }).click();

    await expect(sheet.getByText(L.didYouPay)).not.toBeVisible();
    await expect(sheet.locator('#payment-sheet-utr')).not.toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeEnabled();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});

test('PRF-03 — resume prompt does not appear if Pay Now was never tapped', async ({ page }) => {
  const vendor = await createVendor('03');
  const msg = `PRF-03 no pay tap ${T}`;
  const { requestId } = await seedFulfilledOrderWithUnpaidBill(vendor.id, msg);

  try {
    await stubUpiDeepLinkOpen(page);
    await seedCustomer();
    await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
    await gotoMyOrders(page);
    await openPaymentSheetFromOrder(page, msg);

    const sheet = paymentSheet(page);
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeVisible();

    await simulateAppResume(page);

    await expect(sheet.getByText(L.didYouPay)).not.toBeVisible({ timeout: 2000 });
    await expect(sheet.getByRole('button', { name: L.yesPaid, exact: true })).not.toBeVisible();
    await expect(sheet.getByRole('button', { name: L.noPaid, exact: true })).not.toBeVisible();
    await expect(sheet.locator('#payment-sheet-utr')).not.toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeVisible();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});

test('PRF-04 — auto-rating does not stack over payment sheet', async ({ page }) => {
  const vendor = await createVendor('04');
  const msg = `PRF-04 auto-rating gate ${T}`;
  const { requestId } = await seedFulfilledOrderWithUnpaidBill(vendor.id, msg);

  try {
    await seedCustomer();
    await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
    await gotoMyOrders(page);
    await openPaymentSheetFromOrder(page, msg);

    const sheet = paymentSheet(page);
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(700);
    await expect(page.getByTestId('rating-sheet')).not.toBeVisible();
    await expect(sheet.getByRole('button', { name: L.payNow })).toBeEnabled();
    await sheet.getByRole('button', { name: L.payNow }).click();
    await expect(page.locator('body')).toBeVisible();
  } finally {
    await cleanupRequest(requestId);
    await cleanupVendor(vendor.id);
  }
});
