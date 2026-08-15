/**
 * Early UPI claim (accepted + bill) must not affect post-fulfillment rating flow.
 */
import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const CUSTOMER_PHONE = `8816${String(T).slice(-6)}`;
const DEVICE_ID = `device_early_pay_${TEST_SESSION}`;
const UTR = '123456789012';

let vendor: Awaited<ReturnType<typeof createTestVendor>>;

test.beforeAll(async () => {
  vendor = await createTestVendor({ upi_id: 'earlypay@upi' });
  await createTestCustomer(CUSTOMER_PHONE);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData(CUSTOMER_PHONE);
});

async function seedAcceptedUpiBill(message: string) {
  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'accepted',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  const { error: billErr } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: req.id,
    p_vendor_id: vendor.id,
    p_customer_phone: CUSTOMER_PHONE,
    p_total: 199,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'Early pay item', quantity: 1, unit_price: 199, unit: null }],
  });
  if (billErr) throw billErr;

  return req.id as string;
}

async function cleanupOrder(requestId: string) {
  const { data: bill } = await supabaseAdmin
    .from('order_bills')
    .select('id')
    .eq('request_id', requestId)
    .maybeSingle();
  if (bill?.id) {
    await supabaseAdmin.from('order_items').delete().eq('bill_id', bill.id);
    await supabaseAdmin.from('order_bills').delete().eq('id', bill.id);
  }
  await supabaseAdmin.from('vendor_reviews').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
}

test('CPP-EARLY-01 — claim on accepted order succeeds; status stays accepted; rating blocked until fulfilled', async () => {
  const requestId = await seedAcceptedUpiBill(`CPP-EARLY-01 ${T}`);

  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(claimErr).toBeNull();

  const { data: afterClaim } = await supabaseAdmin
    .from('requests')
    .select('status, payment_status, payment_utr')
    .eq('id', requestId)
    .single();
  expect(afterClaim?.status).toBe('accepted');
  expect(afterClaim?.payment_status).toBe('claimed');
  expect(afterClaim?.payment_utr).toBe(UTR);

  const { error: reviewErr } = await supabase.rpc('submit_vendor_review', {
    p_vendor_id: vendor.id,
    p_request_id: requestId,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id: DEVICE_ID,
    p_rating: 5,
    p_review_text: 'should fail',
    p_service_mode: 'delivery',
  });
  expect(reviewErr).not.toBeNull();
  expect(reviewErr?.message).toMatch(/order_not_fulfilled/i);

  const { error: fulfilErr } = await supabaseAdmin.rpc('vendor_fulfil_order', {
    p_request_id: requestId,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(fulfilErr).toBeNull();

  const { data: afterFulfil } = await supabaseAdmin
    .from('requests')
    .select('status, payment_status')
    .eq('id', requestId)
    .single();
  expect(afterFulfil?.status).toBe('fulfilled');
  expect(afterFulfil?.payment_status).toBe('claimed');

  const { error: reviewOkErr } = await supabase.rpc('submit_vendor_review', {
    p_vendor_id: vendor.id,
    p_request_id: requestId,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id: DEVICE_ID,
    p_rating: 4,
    p_review_text: 'after fulfil',
    p_service_mode: 'delivery',
  });
  expect(reviewOkErr).toBeNull();

  await cleanupOrder(requestId);
});

test('CPP-EARLY-02 — browser: early pay then Mark Done still shows rating CTA', async ({ page }) => {
  const requestId = await seedAcceptedUpiBill(`CPP-EARLY-02 ${T}`);

  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(claimErr).toBeNull();

  await supabaseAdmin.rpc('vendor_fulfil_order', {
    p_request_id: requestId,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  const card = page.locator(`#order-card-${requestId}`);
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByTestId('order-rate-btn')).toBeVisible({ timeout: 8000 });
  await card.getByTestId('order-rate-btn').click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });

  await cleanupOrder(requestId);
});
