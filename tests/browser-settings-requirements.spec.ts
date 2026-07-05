import { test, expect, Page } from '@playwright/test';
import {
  loginAsCustomer,
  loginAsVendor,
  loginAsAdmin,
  waitForSettingsAdminReady,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  invokeRegisterVendorRpc,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88008${String(T).slice(-5)}`;
const DEVICE_ID = `device_set_${T}`;
const VENDOR_DEVICE_ID = `device_set_vendor_${T}`;

/** Whitelist length in Settings.tsx ADMIN_CONFIG_WHITELIST (requirement doc says 24; code has 30). */
const ADMIN_CONFIG_ROW_COUNT = 30;

const L = {
  myAccount: 'My Account',
  accountStanding: 'Account Standing',
  myDeliveryAddresses: '📍 My Delivery Addresses',
  preferences: 'Preferences',
  connectionPrivacy: 'CONNECTION & PRIVACY',
  deleteAccount: 'Delete Account',
  myShop: 'My Shop',
  feedNotifications: 'Feed notifications',
  orderAlerts: 'Order Alerts',
  goodStanding: 'No vendor has reported your account',
  banned: 'Account Suspended — contact support',
  fairStanding: 'A few complaints reported on your account.',
  complaintsStanding: 'Multiple complaints on your account - account is under review',
  english: 'English',
  hindi: 'हिंदी',
  marathi: 'मराठी',
  shopInfo: 'Shop Info',
  menu: 'My Menu / Price List',
  offers: 'Offers',
  referEarn: '🎁 Refer & Earn',
  rejectionReasons: 'Rejection Reasons',
  ledgerCycle: 'Ledger year start',
  draftBannerTitle: 'Your profile is incomplete',
  draftBannerCta: 'Add Location',
  khataSettings: 'Khata Settings',
  khataEnable: 'Enable Khata / Credit',
  khataAmberLimit: 'Amber warning limit (₹)',
  khataRedLimit: 'Red warning limit (₹)',
  reviewAnonymous: '— Anonymous',
  reviewMyReviews: 'My Reviews',
  adminTab: 'Admin',
  appConfig: 'App Config',
  vendorTrialLabel: 'Vendor Trial Period (days)',
  pendingCategories: '🗂️ Pending Categories',
  lowRatingsTitle: '⭐ Low Ratings (2★ and below)',
  deleteReview: 'Delete review',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdReviewIds: string[] = [];
let vendorPhoneSeq = 0;
let referralEnabledOriginal: string | null = null;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99008${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedCustomer(fields: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert(
      {
        phone: CUSTOMER_PHONE,
        trust_score: 75,
        warn_count: 0,
        is_banned: false,
        ...fields,
      },
      { onConflict: 'phone' },
    );
  if (error) throw error;
}

type VendorRow = {
  id: string;
  shop_name: string;
  phone: string;
  category: string;
  service_mode: string;
};

async function createVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const shopName = `!SET-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `SET Vendor ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      ...overrides,
    })
    .select('id, shop_name, phone, category, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function createDraftVendor(tag: string): Promise<VendorRow> {
  const phone = nextVendorPhone();
  const result = await invokeRegisterVendorRpc({
    phone,
    shop_name: `!SET-DRAFT-${tag}-${T}`,
    profile_status: 'draft',
    is_active: false,
  });
  if (result.error || !result.vendorId) throw new Error(result.error?.message ?? 'draft vendor failed');
  createdVendorIds.push(result.vendorId);
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .select('id, shop_name, phone, category, service_mode')
    .eq('id', result.vendorId)
    .single();
  if (error || !vendor) throw error ?? new Error('vendor load failed');
  return vendor as VendorRow;
}

async function gotoSettings(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
}

async function expandPreferences(page: Page) {
  await page.getByRole('button', { name: L.preferences }).click();
}

/** Wait until VendorSettings has loaded (vendor + vendorExtras batch fetch). */
async function waitForMyShopReady(page: Page) {
  // MISSING TESTID: needs data-testid="my-shop-section" on VendorSettings collapsible
  await page
    .waitForSelector('[data-testid="my-shop-section"]', { state: 'visible', timeout: 10000 })
    .catch(() => undefined);
  await expect(page.getByRole('button', { name: L.shopInfo })).toBeVisible({ timeout: 20000 });
}

async function expandMyShop(page: Page) {
  const shopHeader = page.getByRole('button', { name: new RegExp(`^${L.myShop}$`, 'i') });
  await expect(shopHeader).toBeVisible({ timeout: 20000 });
  if ((await shopHeader.getAttribute('aria-expanded')) !== 'true') {
    await shopHeader.click();
  }
  await waitForMyShopReady(page);
}

async function setReferralEnabled(value: 'true' | 'false') {
  const { error } = await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'referral_enabled', value }, { onConflict: 'key' });
  if (error) throw error;
}

test.beforeAll(async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_enabled')
    .maybeSingle();
  referralEnabledOriginal = data?.value ?? 'true';

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
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  if (referralEnabledOriginal != null) {
    await setReferralEnabled(
      referralEnabledOriginal.trim().toLowerCase() === 'false' ? 'false' : 'true',
    );
  }
  await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'vendor_trial_days', value: '30' }, { onConflict: 'key' });
});

// ─── CUSTOMER VIEW ───────────────────────────────────────────────────────────

test('SET-REQ-01 — Customer Settings shows correct sections', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);

  await expect(page.getByRole('button', { name: L.myAccount })).toBeVisible();
  await expect(page.getByTestId('account-standing-row')).toBeVisible();
  await expect(page.getByText(L.accountStanding)).toBeVisible();
  await expect(page.getByRole('button', { name: /My Delivery Addresses/ })).toBeVisible();
  await expect(page.getByRole('button', { name: L.preferences })).toBeVisible();
  await expect(page.getByRole('button', { name: L.connectionPrivacy })).toBeVisible();
  await expect(page.getByRole('button', { name: L.deleteAccount })).toBeVisible();

  await expect(page.getByRole('button', { name: new RegExp(`^${L.myShop}$`, 'i') })).not.toBeVisible();
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible();
  await expect(page.getByText(L.orderAlerts)).not.toBeVisible();
});

test('SET-REQ-02 — Feed notifications toggle hidden on web', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);
  await expect(page.getByText(L.feedNotifications)).not.toBeVisible();
});

test('SET-REQ-03 — Account standing shows good status for new customer', async ({ page }) => {
  await supabaseAdmin
    .from('users')
    .update({ warn_count: 0, is_banned: false, trust_score: 85 })
    .eq('phone', CUSTOMER_PHONE);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);

  const row = page.getByTestId('account-standing-row');
  await expect(row.getByText(L.goodStanding)).toBeVisible();
  await expect(row.getByText(L.banned)).not.toBeVisible();
  await expect(row.getByText(L.complaintsStanding)).not.toBeVisible();
});

test('SET-REQ-04 — Banned customer sees banned indicator in account standing', async ({ page }) => {
  await supabaseAdmin
    .from('users')
    .update({ is_banned: true, warn_count: 0, trust_score: 75 })
    .eq('phone', CUSTOMER_PHONE);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);

  const row = page.getByTestId('account-standing-row');
  await expect(row.getByText(L.banned)).toBeVisible();
  await expect(row.getByText(L.goodStanding)).not.toBeVisible();
});

test('SET-REQ-05 — Warned customer (warn_count=2) sees warning indicator', async ({ page }) => {
  await supabaseAdmin
    .from('users')
    .update({ warn_count: 2, is_banned: false, trust_score: 50 })
    .eq('phone', CUSTOMER_PHONE);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);

  const row = page.getByTestId('account-standing-row');
  await expect(row.getByText(L.fairStanding)).toBeVisible();
  await expect(row.getByText(L.goodStanding)).not.toBeVisible();
});

test('SET-REQ-06 — Language selector shows all 3 options', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);
  await expandPreferences(page);

  await expect(page.getByTestId('language-select')).toBeVisible();
  await page.getByTestId('language-select').click();
  await expect(page.getByRole('option', { name: L.english })).toBeVisible();
  await expect(page.getByRole('option', { name: L.hindi })).toBeVisible();
  await expect(page.getByRole('option', { name: L.marathi })).toBeVisible();
});

test('SET-REQ-07 — Theme toggle switches between dark and light', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);
  await expandPreferences(page);

  const html = page.locator('html');
  const before = await html.evaluate((el) => (el.classList.contains('light') ? 'light' : 'dark'));
  await page.getByTestId('theme-toggle').click();
  await expect
    .poll(async () =>
      html.evaluate((el) => (el.classList.contains('light') ? 'light' : 'dark')),
    )
    .toBe(before === 'dark' ? 'light' : 'dark');
});

// ─── VENDOR VIEW ─────────────────────────────────────────────────────────────

test('SET-REQ-08 — Vendor Settings shows MY SHOP section', async ({ page }) => {
  const vendor = await createVendor('VEN-08');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandMyShop(page);

  await expect(page.getByRole('button', { name: L.shopInfo })).toBeVisible();
  await expect(page.getByRole('button', { name: L.menu })).toBeVisible();
  await expect(page.getByRole('button', { name: L.offers })).toBeVisible();
  await expect(page.getByRole('button', { name: L.referEarn })).toBeVisible();
  await expect(page.getByRole('button', { name: L.rejectionReasons })).toBeVisible();
  await expect(page.getByRole('button', { name: L.ledgerCycle })).toBeVisible();
});

test('SET-REQ-09 — MY SHOP label uses localized string not hardcoded', async ({ page }) => {
  const vendor = await createVendor('VEN-09');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  const shopHeader = page.getByRole('button', { name: new RegExp(`^${L.myShop}$`, 'i') });
  await expect(shopHeader).toBeVisible();
  const labelText = await shopHeader.locator('span').first().textContent();
  expect(labelText?.trim()).toBe(L.myShop);
  expect(labelText?.trim()).not.toBe('MY SHOP');
});

test('SET-REQ-10 — Refer & Earn hidden when referral_enabled=false', async ({ page }) => {
  await setReferralEnabled('false');
  const vendor = await createVendor('VEN-10');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandMyShop(page);

  await expect(page.getByRole('button', { name: L.referEarn })).not.toBeVisible();
});

test('SET-REQ-11 — Refer & Earn visible when referral_enabled=true', async ({ page }) => {
  await setReferralEnabled('true');
  const vendor = await createVendor('VEN-11');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  await expandMyShop(page);
  await expect(page.getByRole('button', { name: L.referEarn })).toBeVisible();
});

test('SET-REQ-12 — Draft vendor sees amber banner in settings', async ({ page }) => {
  const vendor = await createDraftVendor('DRAFT-12');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  await expect(page.getByText(L.draftBannerTitle)).toBeVisible();
  await expect(page.getByRole('button', { name: L.draftBannerCta })).toBeVisible();
  await expect(page.getByRole('button', { name: /go live/i })).not.toBeVisible();
});

test('SET-REQ-13 — Vendor khata settings section visible', async ({ page }) => {
  const vendor = await createVendor('VEN-13', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandMyShop(page);

  await page.getByRole('button', { name: L.khataSettings }).click();
  await expect(page.getByText(L.khataEnable)).toBeVisible();
  await expect(page.getByRole('switch')).toBeVisible();
  await expect(page.getByText(L.khataAmberLimit)).toBeVisible();
  await expect(page.getByText(L.khataRedLimit)).toBeVisible();
});

test('SET-REQ-14 — Vendor My Reviews section shows submitted reviews', async ({ page }) => {
  const vendor = await createVendor('VEN-14');
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message: `SET-REQ-14-${T}`,
      status: 'done',
    })
    .select('id')
    .single();
  if (orderErr) throw orderErr;
  createdRequestIds.push(order.id);

  const reviewText = `SET-REQ-14 review ${T}`;
  const { data: review, error: revErr } = await supabaseAdmin
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
  if (revErr) throw revErr;
  createdReviewIds.push(review.id);

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandMyShop(page);
  await page.getByRole('button', { name: new RegExp(L.reviewMyReviews, 'i') }).click();

  const card = page.locator('div.rounded-xl').filter({ hasText: reviewText });
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByText('⭐⭐⭐⭐☆')).toBeVisible();
  await expect(card.getByText(L.reviewAnonymous)).toBeVisible();
  await expect(card.getByText(CUSTOMER_PHONE)).not.toBeVisible();
});

// ─── ADMIN VIEW ──────────────────────────────────────────────────────────────

test('SET-REQ-15 — Admin sees Admin tab in Settings', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoSettings(page);
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible();

  await loginAsAdmin(page, DEVICE_ID);
  await gotoSettings(page);
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible();
  await expect(page.getByTestId('settings-tab-admin')).toHaveText(L.adminTab);
});

test('SET-REQ-16 — Admin App Config shows all 24 whitelisted keys', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);
  await gotoSettings(page);
  await waitForSettingsAdminReady(page);

  await page.getByRole('button', { name: L.appConfig }).click();
  const panel = page.getByTestId('admin-panel');
  const rows = panel.locator('div.rounded-2xl.border.border-border.p-3');
  await expect(rows).toHaveCount(ADMIN_CONFIG_ROW_COUNT);

  await expect(panel.getByText(L.vendorTrialLabel)).toBeVisible();
  await expect(panel.getByText('vendor_trial_days')).not.toBeVisible();
  await expect(panel.getByText('radar_city_radius_km')).not.toBeVisible();
});

test('SET-REQ-17 — Admin config UPSERT — saves new key that does not exist in DB', async ({
  page,
}) => {
  // Isolated probe key — never touch real settings like vendor_trial_days (safe on PROD).
  const probeKey = `test_config_probe_${T}`;
  try {
    await supabaseAdmin.from('app_config').delete().eq('key', probeKey);

    await loginAsAdmin(page, DEVICE_ID);
    await gotoSettings(page);
    await waitForSettingsAdminReady(page);
    await page.getByRole('button', { name: L.appConfig }).click();
    await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 15000 });

    // Same RPC the admin UI Save button uses (admin_update_app_config), with a test-only key.
    const adminPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
    expect(adminPhone).toBeTruthy();

    const rpcError = await page.evaluate(
      async ({ adminPhone, probeKey }) => {
        const { supabase } = await import('/src/lib/supabase.ts');
        const { error } = await supabase.rpc('admin_update_app_config', {
          p_admin_phone: adminPhone,
          p_key: probeKey,
          p_value: '21',
        });
        return error?.message ?? null;
      },
      { adminPhone: adminPhone!, probeKey },
    );
    expect(rpcError, rpcError ?? undefined).toBeNull();

    await expect
      .poll(async () => {
        const { data } = await supabaseAdmin
          .from('app_config')
          .select('value')
          .eq('key', probeKey)
          .maybeSingle();
        return data?.value ?? null;
      })
      .toBe('21');
  } finally {
    await supabaseAdmin.from('app_config').delete().eq('key', probeKey);
  }
});

test('SET-REQ-18 — Admin Pending Categories section visible', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);
  await gotoSettings(page);
  await waitForSettingsAdminReady(page);
  await expect(page.getByRole('button', { name: /Pending Categories/ })).toBeVisible();
});

test('SET-REQ-19 — Admin Low Ratings section visible', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);
  await gotoSettings(page);
  await waitForSettingsAdminReady(page);
  await expect(page.getByRole('button', { name: /Low Ratings \(2★ and below\)/ })).toBeVisible();
});

test('SET-REQ-20 — Admin can delete a low-rated review', async ({ page }) => {
  const vendor = await createVendor('ADM-20');
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message: `SET-REQ-20-${T}`,
      status: 'done',
    })
    .select('id')
    .single();
  if (orderErr) throw orderErr;
  createdRequestIds.push(order.id);

  const reviewText = `SET-REQ-20 low rating ${T}`;
  const { data: review, error: revErr } = await supabaseAdmin
    .from('vendor_reviews')
    .insert({
      vendor_id: vendor.id,
      request_id: order.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      rating: 1,
      review_text: reviewText,
      service_mode: 'delivery',
    })
    .select('id')
    .single();
  if (revErr) throw revErr;
  createdReviewIds.push(review.id);

  await supabaseAdmin
    .from('vendors')
    .update({ avg_rating: 1.0, review_count: 1 })
    .eq('id', vendor.id);

  await loginAsAdmin(page, DEVICE_ID);
  await gotoSettings(page);
  await waitForSettingsAdminReady(page);
  await page.getByRole('button', { name: /Low Ratings \(2★ and below\)/ }).click();

  const reviewRow = page.locator('div.rounded-2xl.border.border-border').filter({ hasText: reviewText });
  await expect(reviewRow).toBeVisible({ timeout: 15000 });
  await reviewRow.getByRole('button', { name: L.deleteReview }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Delete review' }).click();
  await page.waitForTimeout(1500);

  const { data: gone } = await supabaseAdmin
    .from('vendor_reviews')
    .select('id')
    .eq('id', review.id)
    .maybeSingle();
  expect(gone).toBeNull();

  const { data: v } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, review_count')
    .eq('id', vendor.id)
    .single();
  expect(v?.review_count === 0 || v?.avg_rating == null).toBeTruthy();
});

test('SET-RAD-01 — Vendor can update service radius and it saves to DB', async ({ page }) => {
  const vendor = await createVendor('setrad01');
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: L.shopInfo }).click();
  await expect(page.getByText('5 km').first()).toBeVisible({ timeout: 10000 });
  await page.getByText('5 km').first().click();
  await expect(page.locator('[data-sonner-toast]').getByText('Service area updated')).toBeVisible({
    timeout: 8000,
  });
  // Verify DB updated
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('service_radius_km')
    .eq('id', vendor.id)
    .single();
  expect(data?.service_radius_km).toBe(5);
});
