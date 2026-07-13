/**
 * Browser requirement verifications for R1–R5.
 * Each test title states the product rule a non-developer would recognize.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  loginAsCustomer,
  loginAsVendor,
  loginAsAdminViaSession,
  openVendorPreferencesTab,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const CUSTOMER_PHONE = `88072${String(T).slice(-5)}`;
const CUSTOMER_DEVICE = `device_r125_${T}`;

const L = {
  phoneInvalidBody: 'Enter a valid 10-digit Indian mobile number.',
  reachLabel: 'Who can see this post?',
  reachCityWide: 'My whole city',
  reach1: '1 km',
  reach5: '5 km',
  reach25: '25 km',
  composeTitle: 'New post',
  callNow: '📞 Call Now',
  aiBridge: 'AI-Bridge',
  offerAudienceVendors: 'Vendors',
} as const;

const createdVendorIds: string[] = [];
const createdPostIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [CUSTOMER_PHONE];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  const phone = `99072${String(T + vendorPhoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedCustomer(phone = CUSTOMER_PHONE) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function createVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
  categoryLabel?: string,
) {
  const category = categoryLabel
    ? await getActiveCategoryByLabel(categoryLabel)
    : await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const shopName = `!R-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Owner ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: category.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
      ...overrides,
    })
    .select('id, phone, shop_name, category')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return { ...vendor, categoryRow: category };
}

async function setupGps(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
}

test.beforeAll(async () => {
  await seedCustomer();
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('saved_vendors').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('feed_posts').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  await supabaseAdmin.from('users').delete().in('phone', createdPhones);
});

async function fillWizardStepAIdentity(
  page: Page,
  opts: { name: string; phone: string; upi: string },
) {
  await page.getByPlaceholder('Ramesh Kumar').fill(opts.name);
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(opts.phone);
  await page.getByPlaceholder('name@okbank').fill(opts.upi);
  // Base type must be chosen first — otherwise Next stops before phone validation.
  await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
}

async function seedOfferPost(
  vendor: { id: string; phone: string },
  content: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: vendor.id,
      user_phone: vendor.phone,
      content,
      lat: PUNE.latitude,
      lng: PUNE.longitude,
      locality: 'Pune',
      is_hidden: false,
      reach_radius_km: 9999,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdPostIds.push(data.id);
  return data;
}

// ─── R1 — Phone format ───────────────────────────────────────────────────────

test('R1-01 — Vendor registration with too-short phone is rejected with the specific Indian-mobile error', async ({
  page,
}) => {
  await setupGps(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await fillWizardStepAIdentity(page, {
    name: 'R1 Short Phone',
    phone: '98765',
    upi: 'r1short@upi',
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText(L.phoneInvalidBody, { exact: false })).toBeVisible({
    timeout: 8000,
  });
  await expect(page.getByPlaceholder('+91 98xxxxxxxx')).toBeVisible();
});

test('R1-02 — Vendor registration with letters in the phone is rejected with the same specific error', async ({
  page,
}) => {
  await setupGps(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await fillWizardStepAIdentity(page, {
    name: 'R1 Letters Phone',
    phone: '98765abc10',
    upi: 'r1letters@upi',
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText(L.phoneInvalidBody, { exact: false })).toBeVisible({
    timeout: 8000,
  });
});

test('R1-03 — Vendor registration with wrong leading digit is rejected with the specific error', async ({
  page,
}) => {
  await setupGps(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await fillWizardStepAIdentity(page, {
    name: 'R1 Leading Digit',
    phone: '5876543210',
    upi: 'r1lead@upi',
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await expect(page.getByText(L.phoneInvalidBody, { exact: false })).toBeVisible({
    timeout: 8000,
  });
});

// ─── R2 — Hidden / non-discoverable vendors ──────────────────────────────────

test('R2-01 — Non-discoverable vendor does not appear when a customer searches by category on Radar', async ({
  page,
}) => {
  const vendor = await createVendor('HID-RADAR', { discoverable: false }, 'Pharmacy');
  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.goto(
    `${APP_URL}/radar?q=${encodeURIComponent(vendor.category)}&mode=delivery`,
  );
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
  await expect(page.getByText(vendor.shop_name, { exact: false })).toHaveCount(0, {
    timeout: 10000,
  });
});

test('R2-02 — Non-discoverable vendor does not appear in the customer saved-shops list', async ({
  page,
}) => {
  const vendor = await createVendor('HID-SAVED', { discoverable: false }, 'Pharmacy');
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: CUSTOMER_PHONE,
    vendor_id: vendor.id,
    nickname: vendor.shop_name,
    category: vendor.category,
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.goto(APP_URL);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(vendor.shop_name, { exact: false })).toHaveCount(0, {
    timeout: 10000,
  });
});

test('R2-03 — Non-discoverable vendor can still post an offer that readers see on the feed', async ({
  page,
}) => {
  const vendor = await createVendor('HID-FEED', { discoverable: false }, 'Pharmacy');
  const content = `R2-hidden-vendor-offer-${T}`;
  await seedOfferPost(vendor, content, { target_audience: 'customers' });

  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(content)).toBeVisible({ timeout: 20000 });
});

test('R2-04 — Non-discoverable vendor still appears in the admin vendor list', async ({
  page,
}) => {
  const vendor = await createVendor('HID-ADMIN', { discoverable: false }, 'Pharmacy');
  await loginAsAdminViaSession(page, `admin_r2_${T}`);
  const modBtn = page.getByRole('button', { name: /Vendor moderation|Vendors/i }).first();
  if (await modBtn.isVisible().catch(() => false)) {
    const searchVisible = await page
      .getByPlaceholder(/search by name, shop, phone/i)
      .isVisible()
      .catch(() => false);
    if (!searchVisible) await modBtn.click();
  }
  const searchInput = page.getByPlaceholder(/search by name, shop, phone/i).first();
  await expect(searchInput).toBeVisible({ timeout: 10000 });
  await searchInput.fill(vendor.shop_name);
  await expect(page.locator(`#admin-vendor-${vendor.id}`)).toBeVisible({ timeout: 15000 });
});

// ─── R3 — Offer audience ─────────────────────────────────────────────────────

test('R3-01 — Customer reading the feed never sees a vendors-only offer', async ({ page }) => {
  const vendor = await createVendor('AUD-VONLY', {}, 'Pharmacy');
  const content = `R3-vendors-only-ui-${T}`;
  await seedOfferPost(vendor, content, {
    target_audience: 'vendors',
    target_category_id: null,
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(content)).toHaveCount(0, { timeout: 10000 });
});

test('R3-02 — A vendor reading the feed does see a vendors-only offer', async ({ page }) => {
  const poster = await createVendor('AUD-POST', {}, 'Pharmacy');
  const reader = await createVendor('AUD-READ', {}, 'Pharmacy');
  const content = `R3-vendors-only-visible-${T}`;
  await seedOfferPost(poster, content, {
    target_audience: 'vendors',
    target_category_id: null,
  });

  await loginAsVendor(page, reader.phone, reader.id, `vdev_r3_${T}`);
  await setupGps(page);
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(content)).toBeVisible({ timeout: 20000 });
});

test('R3-03 — Pharmacy-targeted offer: Pharmacy vendor sees it, Grocery vendor does not', async ({
  page,
}) => {
  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const poster = await createVendor('AUD-PH-POST', {}, 'Pharmacy');
  const pharmReader = await createVendor('AUD-PH-READ', {}, 'Pharmacy');
  const groceryReader = await createVendor('AUD-GR-READ', {}, 'Grocery');
  const content = `R3-pharmacy-target-ui-${T}`;
  await seedOfferPost(poster, content, {
    target_audience: 'vendors',
    target_category_id: pharmacy.id,
  });

  await loginAsVendor(page, pharmReader.phone, pharmReader.id, `vdev_ph_${T}`);
  await setupGps(page);
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByText(content)).toBeVisible({ timeout: 20000 });

  await loginAsVendor(page, groceryReader.phone, groceryReader.id, `vdev_gr_${T}`);
  await setupGps(page);
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(content)).toHaveCount(0, { timeout: 10000 });
});

test('R3-04 — Customer compose screen has no vendor/category audience targeting controls', async ({
  page,
}) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByRole('heading', { name: L.composeTitle })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(L.offerAudienceVendors, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Who should see this offer?')).toHaveCount(0);
});

// ─── R4 — Reach options ──────────────────────────────────────────────────────

test('R4-01 — Customer composing a post sees modest reach chips and cannot pick city-wide', async ({
  page,
}) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await setupGps(page);
  await page.goto(`${APP_URL}/feed`);
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByRole('heading', { name: L.composeTitle })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByText(L.reachLabel).first()).toBeVisible();
  await expect(page.getByRole('button', { name: L.reach1 }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: L.reach5 }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: L.reach25 }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: L.reachCityWide })).toHaveCount(0);
});

test('R4-02 — Vendor composing an offer can select full city / nationwide reach', async ({
  page,
}) => {
  const vendor = await createVendor('REACH-V', {}, 'Pharmacy');
  await loginAsVendor(page, vendor.phone, vendor.id, `vdev_reach_${T}`);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
  await openVendorPreferencesTab(page);
  await page.getByRole('button', { name: /^Offers$/ }).click();
  await expect(page.getByText(L.reachLabel).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: L.reachCityWide }).first()).toBeVisible({
    timeout: 10000,
  });
});

// ─── R5 — Call vendor from bill ──────────────────────────────────────────────

test('R5-01 — Customer with a received bill can tap Call Now and opens the trusted AI-Bridge caller', async ({
  page,
}) => {
  const vendor = await createVendor('BILL-CALL', {}, 'Pharmacy');
  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: CUSTOMER_DEVICE,
      message: `R5 bill call ${T}`,
      status: 'accepted',
      delivery_slot: 'morning',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  createdRequestIds.push(req.id);

  const { error: billErr } = await supabaseAdmin.from('order_bills').insert({
    request_id: req.id,
    vendor_id: vendor.id,
    user_phone: CUSTOMER_PHONE,
    total_amount: 150,
    payment_status: 'unpaid',
  });
  if (billErr) throw billErr;

  let initiateCallHit = false;
  await page.route('**/functions/v1/initiate-call**', async (route) => {
    initiateCallHit = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, call_sid: 'CA_TEST_R5' }),
    });
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByText(`R5 bill call ${T}`)).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: L.callNow }).first().click();
  await expect(page.getByText(L.aiBridge).first()).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: L.callNow }).last().click();
  await expect.poll(() => initiateCallHit, { timeout: 10000 }).toBe(true);
});
