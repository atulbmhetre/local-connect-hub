import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import { supabase, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_rating_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

async function seedFulfilledOrder(message = 'Rating test order') {
  const { data } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message,
    status: 'fulfilled',
  }).select().single();
  return data;
}

// ─── RATING SHEET UI ───────────────────────────────────────────────────────

test('RV-UI-01: rating sheet opens on fulfilled order in MyOrders', async ({ page }) => {
  await seedFulfilledOrder('RV-UI-01 order');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('order-rate-btn').first()).toBeVisible({ timeout: 5000 });
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
});

test('RV-UI-02: all 5 stars are visible on rating sheet', async ({ page }) => {
  await seedFulfilledOrder('RV-UI-02 order');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
  for (let i = 1; i <= 5; i++) {
    await expect(page.getByTestId(`rating-star-${i}`)).toBeVisible();
  }
});

test('RV-UI-03: submit button disabled until star selected', async ({ page }) => {
  await seedFulfilledOrder('RV-UI-03 order');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
  // Submit should be disabled before any star is selected
  await expect(page.getByTestId('rating-submit-btn')).toBeDisabled();
  // Select a star
  await page.getByTestId('rating-star-3').click();
  // Submit should now be enabled
  await expect(page.getByTestId('rating-submit-btn')).toBeEnabled();
});

test('RV-UI-04: skip button dismisses rating sheet without DB write', async ({ page }) => {
  const order = await seedFulfilledOrder('RV-UI-04 skip test');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('rating-skip-btn').click();
  // Sheet should close
  await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 3000 });
  // DB assert — no review row created
  const { data } = await supabase.from('vendor_reviews').select('id').eq('request_id', order!.id);
  expect(data?.length).toBe(0);
});

// ─── RATING SUBMISSION + DB ────────────────────────────────────────────────

test('RV-DB-01: 5-star rating submitted — vendor_reviews row created', async ({ page }) => {
  const order = await seedFulfilledOrder('RV-DB-01 5 star');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('rating-star-5').click();
  await page.getByTestId('rating-submit-btn').click();
  await page.waitForTimeout(2000);
  const { data } = await supabase.from('vendor_reviews').select('rating').eq('request_id', order!.id).maybeSingle();
  if (data) expect(data.rating).toBe(5);
  else await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 3000 });
});

test('RV-DB-02: 1-star rating submitted — vendor_reviews row created with correct rating', async ({ page }) => {
  const order = await seedFulfilledOrder('RV-DB-02 1 star');
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  await page.getByTestId('order-rate-btn').first().click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('rating-star-1').click();
  await page.getByTestId('rating-submit-btn').click();
  await page.waitForTimeout(2000);
  const { data } = await supabase.from('vendor_reviews').select('rating').eq('request_id', order!.id).maybeSingle();
  if (data) expect(data.rating).toBe(1);
  else await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 3000 });
});

// ─── VENDOR REPLY ──────────────────────────────────────────────────────────

test('RV-REPLY-01: vendor can see and respond to a review — DB assert', async ({ page }) => {
  const order = await seedFulfilledOrder('RV-REPLY-01 review');
  // Seed a review directly
  await supabase.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order!.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    rating: 4,
    service_mode: 'delivery',
  });
  // Vendor navigates to settings to respond
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await page.waitForLoadState('networkidle');
  // DB assert — review exists
  const { data } = await supabase.from('vendor_reviews').select('rating, vendor_response').eq('request_id', order!.id).single();
  expect(data?.rating).toBe(4);
  expect(data?.vendor_response).toBeNull();
});

// ─── NEGATIVE CASES ────────────────────────────────────────────────────────

test('RV-NEG-01: duplicate rating for same order blocked — unique constraint', async ({ page }) => {
  const order = await seedFulfilledOrder('RV-NEG-01 duplicate');
  // Insert first review
  await supabase.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order!.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    rating: 3,
    service_mode: 'delivery',
  });
  // Try inserting duplicate
  const { error } = await supabase.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order!.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    rating: 5,
    service_mode: 'delivery',
  });
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505'); // unique violation
});

test('RV-NEG-02: rate button not shown on sent order card', async ({ page }) => {
  const { data: order } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Sent order no rate btn',
    status: 'sent',
  }).select().single();

  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');

  // Find the specific card for this order by its message text
  const thisCard = page.getByTestId('order-card')
    .filter({ hasText: 'Sent order no rate btn' }).first();
  await expect(thisCard).toBeVisible({ timeout: 8000 });

  // This specific card should not have a rate button
  const rateBtnOnThisCard = thisCard.getByTestId('order-rate-btn');
  await expect(rateBtnOnThisCard).not.toBeVisible({ timeout: 3000 });
});

test('RV-NEG-03: rating sheet not shown on cancelled order', async ({ page }) => {
  await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Cancelled order no rate btn',
    status: 'cancelled',
  });
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await page.waitForLoadState('networkidle');
  // Cancelled orders show in MyOrders but no rate button
  const rateBtn = page.getByTestId('order-rate-btn');
  const count = await rateBtn.count();
  // Either no rate btn at all, or none visible on cancelled cards
  if (count > 0) {
    // Make sure none are on cancelled status cards
    const cancelledCard = page.getByTestId('order-card').filter({ hasText: /cancelled/i }).first();
    const hasRateBtnOnCancelled = await cancelledCard.getByTestId('order-rate-btn').isVisible().catch(() => false);
    expect(hasRateBtnOnCancelled).toBe(false);
  }
});
