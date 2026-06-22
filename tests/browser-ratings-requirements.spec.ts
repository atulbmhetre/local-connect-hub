import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88007${String(T).slice(-5)}`;
const DEVICE_ID = `device_rv_${T}`;

const PUNE = { latitude: 18.5204, longitude: 73.8567 };

const L = {
  ratingBtnDelivered: '📦 Delivered on Time',
  ratingBtnHelped: '✅ Vendor Helped Me',
  ratingBtnAppointmentCompleted: '✅ Service Completed',
  ratingBtnIssue: '⚠️ Had an issue',
  radarDeliveredOnTime: '📦 Delivered on Time',
  radarVendorHelped: '✅ Vendor Helped Me',
  radarVendorServed: '✅ Vendor Served Me',
  radarMarked: '✅ Marked!',
  heHelpedMe: 'He Helped Me',
  reviewAnonymous: '— Anonymous',
  reviewMyReviews: 'My Reviews',
  reviewRespond: 'Respond',
  reviewSend: 'Send',
  reviewYourReply: 'Your reply:',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdReviewIds: string[] = [];
const createdNotificationIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99007${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

type VendorRow = {
  id: string;
  shop_name: string;
  category: string;
  service_mode: string;
  phone: string;
};

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `RV Vendor ${tag}`,
      shop_name: `!RV-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      ...overrides,
    })
    .select('id, shop_name, category, service_mode, phone')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedFulfilledOrder(
  vendorId: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'fulfilled',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function getAdminPhone(): Promise<string> {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_phone')
    .maybeSingle();
  return data?.value?.trim() || '8888169446';
}

/** Mirrors src/lib/vendorRating.ts syncVendorRatingFromReviews using supabaseAdmin. */
async function syncVendorRatingFromReviews(
  vendorId: string,
  options?: { shopName?: string; alertAdmin?: boolean },
) {
  const { data: reviews } = await supabaseAdmin
    .from('vendor_reviews')
    .select('rating')
    .eq('vendor_id', vendorId);

  if (!reviews?.length) {
    await supabaseAdmin
      .from('vendors')
      .update({ avg_rating: null, review_count: 0, low_rating_admin_notified: false })
      .eq('id', vendorId);
    return;
  }

  const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  const avgRating = Math.round(avg * 10) / 10;
  const reviewCount = reviews.length;

  const update: {
    avg_rating: number;
    review_count: number;
    low_rating_admin_notified?: boolean;
  } = {
    avg_rating: avgRating,
    review_count: reviewCount,
  };

  if (avgRating > 3.5) {
    update.low_rating_admin_notified = false;
  }

  if (options?.alertAdmin && avgRating < 2.0 && reviewCount >= 5) {
    const { data: vendor } = await supabaseAdmin
      .from('vendors')
      .select('low_rating_admin_notified')
      .eq('id', vendorId)
      .maybeSingle();

    if (!vendor?.low_rating_admin_notified) {
      const adminPhone = await getAdminPhone();
      const shopName = options.shopName?.trim() || 'Vendor';
      const { data: notif } = await supabaseAdmin
        .from('user_notifications')
        .insert({
          user_phone: adminPhone,
          type: 'admin_alert',
          title: 'Low rated vendor alert',
          body: `${shopName} has avg rating ${avgRating} over ${reviewCount} reviews`,
          route: 'vendor',
          route_params: { vendor_id: vendorId },
        })
        .select('id')
        .single();
      if (notif?.id) createdNotificationIds.push(notif.id);
      update.low_rating_admin_notified = true;
    }
  }

  await supabaseAdmin.from('vendors').update(update).eq('id', vendorId);
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

async function openRatingSheetForOrder(page: Page, message: string) {
  await gotoMyOrders(page);
  const card = orderCard(page, message);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('order-rate-btn')).toBeVisible();
  await card.getByTestId('order-rate-btn').click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 8000 });
}

async function setupGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
}

async function gotoRadar(
  page: Page,
  opts: { q?: string; mode?: 'help' | 'delivery' | 'appointment' } = {},
) {
  await setupGeolocation(page);
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.mode) params.set('mode', opts.mode);
  const qs = params.toString();
  await page.goto(`${APP_URL}/radar${qs ? `?${qs}` : ''}`);
  await page.waitForLoadState('networkidle');
}

function vendorCard(page: Page, shopName: string): Locator {
  return page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
}

// MISSING TESTID: needs data-testid on RadarVendorCard resolution button
function resolutionButton(card: Locator): Locator {
  return card.getByRole('button', {
    name: /Delivered on Time|Vendor Helped Me|Vendor Served Me/,
  });
}

test.beforeAll(async () => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', await getAdminPhone());
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await seedCustomer();
});

test.afterAll(async () => {
  if (createdReviewIds.length) {
    await supabaseAdmin.from('vendor_reviews').delete().in('id', createdReviewIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('vendor_reviews').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_reviews').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  if (createdNotificationIds.length) {
    await supabaseAdmin.from('user_notifications').delete().in('id', createdNotificationIds);
  }
  const adminPhone = await getAdminPhone();
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', adminPhone)
    .eq('type', 'admin_alert');
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test.beforeEach(async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
});

// ─── RATING SHEET — UI ELEMENTS ────────────────────────────────────────────

test('RV-REQ-01 — Rating sheet opens on fulfilled order', async ({ page }) => {
  const vendor = await createVendor('delivery', 'UI-01');
  const msg = `RV-REQ-01-${T}`;
  await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);

  for (let i = 1; i <= 5; i++) {
    await expect(page.getByTestId(`rating-star-${i}`)).toBeVisible();
  }
  await expect(page.getByTestId('rating-submit-btn')).toBeVisible();
  await expect(page.getByTestId('rating-submit-btn')).toBeDisabled();
  await expect(page.getByTestId('rating-skip-btn')).toBeVisible();
  await expect(page.getByRole('button', { name: L.ratingBtnIssue })).toBeVisible();
});

test('RV-REQ-02 — Rating sheet submit button enabled after star selection', async ({ page }) => {
  const vendor = await createVendor('delivery', 'UI-02');
  const msg = `RV-REQ-02-${T}`;
  await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);

  await expect(page.getByTestId('rating-submit-btn')).toBeDisabled();
  await page.getByTestId('rating-star-4').click();
  await expect(page.getByTestId('rating-submit-btn')).toBeEnabled();
  await expect(page.getByTestId('rating-star-4')).toHaveClass(/opacity-100/);
  await expect(page.getByTestId('rating-star-5')).toHaveClass(/opacity-30/);
});

test('RV-REQ-03 — Skip closes sheet without DB write', async ({ page }) => {
  const vendor = await createVendor('delivery', 'UI-03');
  const msg = `RV-REQ-03-${T}`;
  const order = await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);

  await page.getByTestId('rating-skip-btn').click();
  await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 5000 });

  const { data: reviews } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id')
    .eq('request_id', order.id);
  expect(reviews?.length ?? 0).toBe(0);

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();
  expect(row?.status).toBe('done');
});

test('RV-REQ-04 — Submit rating creates vendor_reviews row', async ({ page }) => {
  const vendor = await createVendor('delivery', 'UI-04');
  const msg = `RV-REQ-04-${T}`;
  const order = await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);

  await page.getByTestId('rating-star-5').click();
  await page.getByTestId('rating-submit-btn').click();
  await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 10000 });

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id, rating, request_id')
    .eq('request_id', order.id)
    .maybeSingle();
  expect(review?.rating).toBe(5);
  expect(review?.request_id).toBe(order.id);
  if (review?.id) createdReviewIds.push(review.id);

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();
  expect(row?.status).toBe('done');
});

test('RV-REQ-05 — Duplicate rating blocked — rate button hidden after review exists', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'UI-05');
  const msg = `RV-REQ-05-${T}`;
  const order = await seedFulfilledOrder(vendor.id, msg);

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 5,
      service_mode: 'delivery',
    })
    .select('id')
    .single();
  if (review?.id) createdReviewIds.push(review.id);

  await gotoMyOrders(page);
  const card = orderCard(page, msg);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();
});

test('RV-REQ-06 — Issue button increments vendor total_issues', async ({ page }) => {
  const vendor = await createVendor('help', 'UI-06');
  const msg = `RV-REQ-06-${T}`;
  const order = await seedFulfilledOrder(vendor.id, msg);

  const { data: before } = await supabaseAdmin
    .from('vendors')
    .select('total_issues')
    .eq('id', vendor.id)
    .single();
  const issuesBefore = before?.total_issues ?? 0;

  await openRatingSheetForOrder(page, msg);
  await page.getByRole('button', { name: L.ratingBtnIssue }).click();
  await expect(page.getByTestId('rating-sheet')).not.toBeVisible({ timeout: 10000 });

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('total_issues')
    .eq('id', vendor.id)
    .single();
  expect(after?.total_issues).toBe(issuesBefore + 1);

  const { data: reviews } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id')
    .eq('request_id', order.id);
  expect(reviews?.length ?? 0).toBe(0);

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();
  expect(row?.status).toBe('done');
});

// ─── MODE-AWARE COPY ─────────────────────────────────────────────────────────

test('RV-REQ-07 — Delivery rating sheet submit button shows delivery copy', async ({ page }) => {
  const vendor = await createVendor('delivery', 'COPY-07');
  const msg = `RV-REQ-07-${T}`;
  await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);
  await expect(page.getByTestId('rating-submit-btn')).toHaveText(L.ratingBtnDelivered);
});

test('RV-REQ-08 — Appointment rating sheet submit button shows appointment copy', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'COPY-08');
  const msg = `RV-REQ-08-${T}`;
  await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);
  await expect(page.getByTestId('rating-submit-btn')).toHaveText(L.ratingBtnAppointmentCompleted);
});

test('RV-REQ-09 — Help rating sheet submit button shows gender-neutral copy', async ({ page }) => {
  const vendor = await createVendor('help', 'COPY-09');
  const msg = `RV-REQ-09-${T}`;
  await seedFulfilledOrder(vendor.id, msg);
  await openRatingSheetForOrder(page, msg);
  await expect(page.getByTestId('rating-submit-btn')).toHaveText(L.ratingBtnHelped);
  await expect(page.getByTestId('rating-submit-btn')).not.toHaveText(L.heHelpedMe);
});

// ─── RADAR RESOLUTION BUTTONS ────────────────────────────────────────────────

test('RV-REQ-10 — Delivery fulfilled — Radar shows "Delivered on Time" resolution button', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'RAD-10');
  const control = await createVendor('delivery', 'RAD-10-CTRL');
  await seedFulfilledOrder(vendor.id, `RV-REQ-10-${T}`);

  await gotoRadar(page, { q: vendor.category, mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await expect(resolutionButton(card)).toBeVisible();
  await expect(resolutionButton(card)).toHaveText(L.radarDeliveredOnTime);

  const controlCard = vendorCard(page, control.shop_name);
  await expect(controlCard).toBeVisible({ timeout: 15000 });
  await expect(resolutionButton(controlCard)).not.toBeVisible();
});

test('RV-REQ-11 — Help fulfilled — Radar shows "Vendor Helped Me" resolution button', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'RAD-11');
  await seedFulfilledOrder(vendor.id, `RV-REQ-11-${T}`);

  await gotoRadar(page, { mode: 'help' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await expect(resolutionButton(card)).toBeVisible();
  await expect(resolutionButton(card)).toHaveText(L.radarVendorHelped);
  await expect(resolutionButton(card)).not.toHaveText(L.heHelpedMe);
});

test('RV-REQ-12 — Appointment fulfilled — Radar shows "Vendor Served Me" resolution button', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'RAD-12');
  await seedFulfilledOrder(vendor.id, `RV-REQ-12-${T}`);

  await gotoRadar(page, { mode: 'appointment' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await expect(resolutionButton(card)).toBeVisible();
  await expect(resolutionButton(card)).toHaveText(L.radarVendorServed);
});

test('RV-REQ-13 — Resolution button not shown / already marked when review exists — no double count', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'RAD-13');
  const order = await seedFulfilledOrder(vendor.id, `RV-REQ-13-${T}`);

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 4,
      service_mode: 'delivery',
    })
    .select('id')
    .single();
  if (review?.id) createdReviewIds.push(review.id);

  const { data: before } = await supabaseAdmin
    .from('vendors')
    .select('total_delivered')
    .eq('id', vendor.id)
    .single();
  const deliveredBefore = before?.total_delivered ?? 0;

  await gotoRadar(page, { q: vendor.category, mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });

  await expect(resolutionButton(card)).not.toBeVisible();
  // MISSING TESTID: resolution button uses dynamic label (marked vs CTA)
  await expect(card.getByRole('button', { name: L.radarMarked })).toBeVisible();

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('total_delivered')
    .eq('id', vendor.id)
    .single();
  expect(after?.total_delivered).toBe(deliveredBefore);
});

// ─── VENDOR REVIEW VIEW ──────────────────────────────────────────────────────

test('RV-REQ-14 — Vendor sees reviews in Settings → My Reviews', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VEN-14');
  const order = await seedFulfilledOrder(vendor.id, `RV-REQ-14-${T}`);
  const reviewText = 'Great service from RV-REQ-14';

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 5,
      review_text: reviewText,
      service_mode: 'delivery',
    })
    .select('id')
    .single();
  if (review?.id) createdReviewIds.push(review.id);

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });

  const reviewsHeader = page.getByRole('button', { name: new RegExp(L.reviewMyReviews, 'i') });
  await reviewsHeader.scrollIntoViewIfNeeded();
  await reviewsHeader.click();

  const reviewCard = page.locator('div.rounded-xl').filter({ hasText: reviewText });
  await expect(reviewCard).toBeVisible({ timeout: 10000 });
  await expect(reviewCard.getByText('⭐⭐⭐⭐⭐')).toBeVisible();
  await expect(reviewCard.getByText(L.reviewAnonymous)).toBeVisible();
  await expect(reviewCard.getByText(CUSTOMER_PHONE)).not.toBeVisible();
});

test('RV-REQ-15 — Vendor can respond to a review', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VEN-15');
  const order = await seedFulfilledOrder(vendor.id, `RV-REQ-15-${T}`);
  const reviewText = 'RV-REQ-15 review body';
  const responseText = `RV-REQ-15 vendor reply ${T}`;

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 4,
      review_text: reviewText,
      service_mode: 'delivery',
    })
    .select('id')
    .single();
  if (!review?.id) throw new Error('review seed failed');
  createdReviewIds.push(review.id);

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await page.getByRole('button', { name: new RegExp(L.reviewMyReviews, 'i') }).click();

  const reviewCard = page.locator('div.rounded-xl').filter({ hasText: reviewText });
  await reviewCard.getByRole('button', { name: L.reviewRespond }).click();
  await page.getByPlaceholder('Write a reply...').fill(responseText);
  await reviewCard.getByRole('button', { name: L.reviewSend }).click();

  await expect.poll(async () => {
    const { data } = await supabaseAdmin
      .from('vendor_reviews')
      .select('vendor_response, vendor_responded_at')
      .eq('id', review.id)
      .single();
    return data?.vendor_response;
  }).toBe(responseText);

  const { data: row } = await supabaseAdmin
    .from('vendor_reviews')
    .select('vendor_responded_at')
    .eq('id', review.id)
    .single();
  expect(row?.vendor_responded_at).not.toBeNull();
});

test('RV-REQ-16 — Vendor response visible on review card after submit', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VEN-16');
  const order = await seedFulfilledOrder(vendor.id, `RV-REQ-16-${T}`);
  const reviewText = 'RV-REQ-16 review body';
  const responseText = `RV-REQ-16 reply visible ${T}`;

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 3,
      review_text: reviewText,
      service_mode: 'delivery',
      vendor_response: responseText,
      vendor_responded_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (review?.id) createdReviewIds.push(review.id);

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await page.getByRole('button', { name: new RegExp(L.reviewMyReviews, 'i') }).click();

  const reviewCard = page.locator('div.rounded-xl').filter({ hasText: reviewText });
  await expect(reviewCard.getByText(responseText)).toBeVisible({ timeout: 10000 });
  await expect(reviewCard.getByText(L.reviewYourReply)).toBeVisible();
  await expect(reviewCard.getByRole('button', { name: L.reviewRespond })).not.toBeVisible();
});

// ─── ADMIN LOW RATINGS ───────────────────────────────────────────────────────

test('RV-REQ-17 — Low rating admin alert fires when avg < 2.0 with 5+ reviews', async () => {
  const vendor = await createVendor('delivery', 'ADM-17');
  await supabaseAdmin
    .from('vendors')
    .update({ low_rating_admin_notified: false, avg_rating: null, review_count: 0 })
    .eq('id', vendor.id);

  for (let i = 0; i < 5; i++) {
    const order = await seedFulfilledOrder(vendor.id, `RV-REQ-17-${i}-${T}`);
    const { data: row } = await supabaseAdmin
      .from('vendor_reviews')
      .insert({
        vendor_id: vendor.id,
        request_id: order.id,
        user_phone: CUSTOMER_PHONE,
        device_id: DEVICE_ID,
        rating: 1,
        service_mode: 'delivery',
      })
      .select('id')
      .single();
    if (row?.id) createdReviewIds.push(row.id);
  }

  await syncVendorRatingFromReviews(vendor.id, {
    shopName: vendor.shop_name,
    alertAdmin: true,
  });

  const { data: v } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating')
    .eq('id', vendor.id)
    .single();
  expect(v?.avg_rating).toBeLessThan(2.0);

  const adminPhone = await getAdminPhone();
  const { data: alerts } = await supabaseAdmin
    .from('user_notifications')
    .select('id, type')
    .eq('user_phone', adminPhone)
    .eq('type', 'admin_alert');
  expect((alerts ?? []).length).toBeGreaterThanOrEqual(1);
  for (const a of alerts ?? []) createdNotificationIds.push(a.id);
});

test('RV-REQ-18 — Low rating alert NOT fired twice', async () => {
  const vendor = await createVendor('delivery', 'ADM-18');
  await supabaseAdmin
    .from('vendors')
    .update({ low_rating_admin_notified: false, avg_rating: null, review_count: 0 })
    .eq('id', vendor.id);

  for (let i = 0; i < 5; i++) {
    const order = await seedFulfilledOrder(vendor.id, `RV-REQ-18-${i}-${T}`);
    const { data: row } = await supabaseAdmin
      .from('vendor_reviews')
      .insert({
        vendor_id: vendor.id,
        request_id: order.id,
        user_phone: CUSTOMER_PHONE,
        device_id: DEVICE_ID,
        rating: 1,
        service_mode: 'delivery',
      })
      .select('id')
      .single();
    if (row?.id) createdReviewIds.push(row.id);
  }

  await syncVendorRatingFromReviews(vendor.id, {
    shopName: vendor.shop_name,
    alertAdmin: true,
  });
  await syncVendorRatingFromReviews(vendor.id, {
    shopName: vendor.shop_name,
    alertAdmin: true,
  });

  const adminPhone = await getAdminPhone();
  const { count } = await supabaseAdmin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', adminPhone)
    .eq('type', 'admin_alert')
    .ilike('body', `%${vendor.shop_name}%`);
  expect(count).toBe(1);
});

test('RV-REQ-19 — Low rating flag resets when avg recovers above 3.5', async () => {
  const vendor = await createVendor('delivery', 'ADM-19');
  await supabaseAdmin
    .from('vendors')
    .update({ low_rating_admin_notified: true, avg_rating: 1.8, review_count: 5 })
    .eq('id', vendor.id);

  for (let i = 0; i < 6; i++) {
    const order = await seedFulfilledOrder(vendor.id, `RV-REQ-19-${i}-${T}`);
    const { data: row } = await supabaseAdmin
      .from('vendor_reviews')
      .insert({
        vendor_id: vendor.id,
        request_id: order.id,
        user_phone: CUSTOMER_PHONE,
        device_id: DEVICE_ID,
        rating: 5,
        service_mode: 'delivery',
      })
      .select('id')
      .single();
    if (row?.id) createdReviewIds.push(row.id);
  }

  await syncVendorRatingFromReviews(vendor.id, { alertAdmin: true });

  const { data: v } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, low_rating_admin_notified')
    .eq('id', vendor.id)
    .single();
  expect(v?.avg_rating).toBeGreaterThan(3.5);
  expect(v?.low_rating_admin_notified).toBe(false);
});
