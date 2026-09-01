import { test, expect, Page } from '@playwright/test';
import {
  loginAsCustomer,
  loginAsVendor,
  loginAsAdmin,
  waitForSettingsAdminReady,
  openVendorPreferencesTab,
  openVendorMyBusinessTab,
  expandFirstMyBusinessCategoryAccordion,
  expandMyAccountAccordion,
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

/** Whitelist length in Settings.tsx ADMIN_CONFIG_WHITELIST (incl. 7 ops keys). */
const ADMIN_CONFIG_ROW_COUNT = 37;

const L = {
  myAccount: 'My Account',
  accountStanding: 'Account Standing',
  myDeliveryAddresses: '📍 My Delivery Addresses',
  preferences: 'Preferences',
  myBusiness: 'My Business',
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
      base_type: 'shop',
      vendor_type: 'shop',
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
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
  await expandMyAccountAccordion(page);
}

async function expandPreferences(page: Page) {
  await expandMyAccountAccordion(page);
  await page.getByRole('button', { name: L.preferences }).click();
}

async function expandVendorPreferences(page: Page) {
  await openVendorPreferencesTab(page);
}

async function expandMyBusinessOperations(page: Page) {
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);
  await expect(page.getByTestId('my-business-operations')).toBeVisible({ timeout: 20000 });
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
  await expandMyAccountAccordion(page);
  await expect(page.getByTestId('settings-account-standing-toggle')).toBeVisible();
  await page.getByTestId('settings-account-standing-toggle').click();
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
  await expandMyAccountAccordion(page);

  await page.getByTestId('settings-account-standing-toggle').click();
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

  await page.getByTestId('settings-account-standing-toggle').click();
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

  await page.getByTestId('settings-account-standing-toggle').click();
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

test('SET-REQ-08 — Vendor Preferences and My Business show expected sections', async ({ page }) => {
  const vendor = await createVendor('VEN-08');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandVendorPreferences(page);

  await expect(page.getByRole('button', { name: L.referEarn })).toBeVisible();
  await expect(page.getByRole('button', { name: L.ledgerCycle })).toBeVisible();

  await expandMyBusinessOperations(page);
  await expect(page.getByRole('button', { name: L.menu })).toBeVisible();
  await expect(page.getByRole('button', { name: L.offers })).toBeVisible();
  await expect(page.getByRole('button', { name: L.rejectionReasons })).toBeVisible();
});

test('SET-REQ-09 — My Business tab uses localized string not hardcoded', async ({ page }) => {
  const vendor = await createVendor('VEN-09');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  const businessTab = page.getByTestId('settings-vendor-tab-business');
  await expect(businessTab).toBeVisible();
  await expect(businessTab).toHaveText(L.myBusiness);
  expect(L.myBusiness).not.toBe('MY BUSINESS');
});

test('SET-REQ-10 — Refer & Earn hidden when referral_enabled=false', async ({ page }) => {
  await setReferralEnabled('false');
  const vendor = await createVendor('VEN-10');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await expandVendorPreferences(page);

  await expect(page.getByRole('button', { name: L.referEarn })).not.toBeVisible();
});

test('SET-REQ-11 — Refer & Earn visible when referral_enabled=true', async ({ page }) => {
  await setReferralEnabled('true');
  const vendor = await createVendor('VEN-11');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  await expandVendorPreferences(page);
  await expect(page.getByRole('button', { name: L.referEarn })).toBeVisible();
});

test('SET-REQ-12 — Draft vendor sees amber banner in settings', async ({ page }) => {
  const vendor = await createDraftVendor('DRAFT-12');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await openVendorPreferencesTab(page);

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
  await expandVendorPreferences(page);

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
  await expandVendorPreferences(page);
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

  // loginAsAdminViaSession reveals the tab and signs in — do not remount Settings
  // afterward or adminTabRevealed resets to false.
  await loginAsAdmin(page, DEVICE_ID);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('settings-tab-admin')).toHaveText(L.adminTab);
  await expect(page.getByTestId('admin-panel')).toBeVisible();
});

test('SET-REQ-16 — Admin App Config shows all 36 whitelisted keys', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);

  await page.getByRole('button', { name: L.appConfig }).click();
  const panel = page.getByTestId('admin-panel');
  const rows = panel.locator('div.rounded-2xl.border.border-border.p-3');
  await expect(rows).toHaveCount(ADMIN_CONFIG_ROW_COUNT);

  await expect(panel.getByText(L.vendorTrialLabel)).toBeVisible();
  await expect(panel.getByText('vendor_trial_days')).not.toBeVisible();
  await expect(panel.getByText('radar_city_radius_km')).not.toBeVisible();
});

test('SET-REQ-16b — Admin App Config shows defaults for 7 ops keys (never blank)', async ({
  page,
}) => {
  await loginAsAdmin(page, DEVICE_ID);
  await page.getByRole('button', { name: L.appConfig }).click();
  const panel = page.getByTestId('admin-panel');

  const opsLabels: Array<{ key: string; label: string; defaultText: RegExp }> = [
    { key: 'payments_enabled', label: 'Payments Enabled', defaultText: /Default:\s*false/i },
    { key: 'razorpay_key_id', label: 'Razorpay Key ID', defaultText: /Default:\s*\(empty\)/i },
    { key: 'razorpay_kyc_date', label: 'Razorpay KYC Date', defaultText: /Default:/i },
    { key: 'exotel_kyc_date', label: 'Exotel KYC Date', defaultText: /Default:/i },
    {
      key: 'exotel_credits_low_threshold_inr',
      label: 'Exotel Credits Low Threshold (₹)',
      defaultText: /Default:\s*200/i,
    },
    {
      key: 'vendor_grace_period_days',
      label: 'Vendor Grace Period (days)',
      defaultText: /Default:\s*3/i,
    },
    {
      key: 'khata_amber_limit',
      label: 'Khata Amber Limit Default (₹)',
      defaultText: /Default:\s*0/i,
    },
  ];

  for (const { key, label, defaultText } of opsLabels) {
    const row = panel.locator('div.rounded-2xl.border.border-border.p-3').filter({ hasText: label });
    await expect(row, `${key} row visible`).toBeVisible();
    await expect(row.getByTestId(`admin-config-default-${key}`)).toHaveText(defaultText);
  }

  // Previously blank: call-limit keys must show Default + a filled input value.
  for (const { key, label, def } of [
    { key: 'delivery_call_limit_seconds', label: 'Delivery Call Time Limit (seconds)', def: '120' },
    {
      key: 'appointment_call_limit_seconds',
      label: 'Appointment Call Time Limit (seconds)',
      def: '180',
    },
  ] as const) {
    const row = panel.locator('div.rounded-2xl.border.border-border.p-3').filter({ hasText: label });
    await expect(row.getByTestId(`admin-config-default-${key}`)).toHaveText(
      new RegExp(`Default:\\s*${def}`, 'i'),
    );
    await expect(row.locator('input')).toHaveValue(/.+/);
  }

  const aadhaarRow = panel
    .locator('div.rounded-2xl.border.border-border.p-3')
    .filter({ hasText: 'Aadhaar / DigiLocker Verification Enabled' });
  await expect(aadhaarRow.getByTestId('admin-config-default-aadhaar_verification_enabled')).toHaveText(
    /Default:\s*false/i,
  );
});

test('SET-REQ-17 — Admin config UPSERT — non-whitelisted probe key is rejected', async ({
  page,
}) => {
  // Isolated probe key — whitelist must reject arbitrary keys (key_not_allowed).
  const probeKey = `test_config_probe_${T}`;
  try {
    await supabaseAdmin.from('app_config').delete().eq('key', probeKey);

    await loginAsAdmin(page, DEVICE_ID);
    await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 15000 });

    const { getAdminSessionClient } = await import('./helpers/browser-setup');
    const adminClient = await getAdminSessionClient();
    const { error } = await adminClient.rpc('admin_update_app_config', {
      p_admin_phone: 'session-admin',
      p_key: probeKey,
      p_value: '21',
    });
    expect(error?.message ?? '').toMatch(/key_not_allowed/i);

    const { data } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', probeKey)
      .maybeSingle();
    expect(data).toBeNull();
  } finally {
    await supabaseAdmin.from('app_config').delete().eq('key', probeKey);
  }
});

test('SET-REQ-18 — Admin Pending Categories section visible', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);
  await expect(page.getByRole('button', { name: /Pending Categories/ })).toBeVisible();
});

test('SET-REQ-19 — Admin Low Ratings section visible', async ({ page }) => {
  await loginAsAdmin(page, DEVICE_ID);
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
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);
  await expect(page.getByTestId('my-business-radius')).toBeVisible({ timeout: 10000 });
  await page.getByText('5 km').first().click();
  await page.getByTestId('my-business-save').click();
  await expect(page.locator('[data-sonner-toast]').getByText('Business details saved.')).toBeVisible({
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
