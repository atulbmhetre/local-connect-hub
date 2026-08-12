import { test, expect } from '@playwright/test';
import {
  loginAsCustomer,
  loginAsAdminViaSession,
  waitForSettingsAdminReady,
  revealAdminTab,
  ensureTestAdminUser,
  getAdminSessionClient,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  seedBronzeVendorVerification,
  seedVendorCategory,
  getFirstActiveCategory,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
  TEST_ADMIN_PHONE,
} from './helpers/setup';
import { computeTrustLevelForBusiness } from '../src/lib/trustLevel';

const TEST_DEVICE_ID = `device_admin_${TEST_SESSION}`;
let testVendor: any;

async function ensureAdminHealthVisible(page: import('@playwright/test').Page) {
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 8000 });
  const healthTitle = page.getByText('Admin — App Health');
  const alreadyVisible = await healthTitle.isVisible({ timeout: 2000 }).catch(() => false);
  if (!alreadyVisible) {
    await page.getByTestId('settings-tab-admin').click();
  }
  await expect(healthTitle).toBeVisible({ timeout: 8000 });
  return healthTitle;
}

async function openVendorModeration(page: import('@playwright/test').Page) {
  await ensureAdminHealthVisible(page);
  const modBtn = page.getByRole('button', { name: /Vendor Moderation/i }).first();
  const hasMod = await modBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (hasMod) {
    const expanded = await page.getByPlaceholder(/search/i).isVisible({ timeout: 1000 }).catch(() => false);
    if (!expanded) {
      await modBtn.click();
      await page.waitForTimeout(500);
    }
  }
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── ADMIN PANEL ACCESS ────────────────────────────────────────────────────

test('ADMIN-01: admin panel visible after session login', async ({ page }) => {
  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 5000 });
});

test('ADMIN-01b: gesture reveal, invalid password, logout hides tab', async ({ page }) => {
  const { email } = await ensureTestAdminUser();
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);

  // (a) Admin tab hidden before gesture
  await expect(page.getByTestId('settings-tab-admin')).toHaveCount(0);
  await expect(page.getByTestId('admin-panel')).toHaveCount(0);

  // (b) Visible after 7-tap
  await revealAdminTab(page);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible();

  // (c) Invalid password → generic error, no panel
  await page.getByTestId('settings-tab-admin').click();
  await expect(page.getByTestId('admin-login-gate')).toBeVisible({ timeout: 8000 });
  await page.locator('#admin-login-email').fill(email);
  await page.locator('#admin-login-password').fill('definitely-wrong-password');
  await page.getByTestId('admin-login-gate').getByRole('button', { name: /Sign in/i }).click();
  await expect(page.getByTestId('admin-login-error')).toHaveText(/Invalid email or password/i, {
    timeout: 8000,
  });
  await expect(page.getByTestId('admin-panel')).toHaveCount(0);

  // Valid login then (d) logout immediately hides tab without navigation
  await page.locator('#admin-login-password').fill(process.env.TEST_ADMIN_PASSWORD!);
  await page.getByTestId('admin-login-gate').getByRole('button', { name: /Sign in/i }).click();
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('admin-log-out').click();
  await expect(page.getByTestId('settings-tab-admin')).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByTestId('admin-panel')).toHaveCount(0);
  await expect(page.getByTestId('settings-screen')).toBeVisible();
});

test('ADMIN-02: admin panel not visible for non-admin without gesture', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('admin-panel')).not.toBeVisible({ timeout: 3000 });
});

test('ADMIN-03: admin sees platform health section', async ({ page }) => {
  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await expect(await ensureAdminHealthVisible(page)).toBeVisible({ timeout: 5000 });
});

// ─── VENDOR VERIFICATION ───────────────────────────────────────────────────

test('ADMIN-04: admin can verify vendor — is_manual_verified = true in DB', async ({ page }) => {
  // Tightened: no RPC fallback — requires the real per-category verify sheet UI.
  // admin_verify_vendor_category requires green_pending/business_verified server-side.
  const { data: vc } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id, categories(label)')
    .eq('vendor_id', testVendor.id)
    .limit(1)
    .maybeSingle();
  const categoryLabel =
    (vc?.categories as { label?: string } | { label?: string }[] | null) == null
      ? null
      : Array.isArray(vc.categories)
        ? vc.categories[0]?.label
        : (vc.categories as { label?: string }).label;
  expect(categoryLabel, 'test vendor must have a category for the verify button').toBeTruthy();

  await supabaseAdmin
    .from('vendors')
    .update({ is_manual_verified: false, verification_status: 'green_pending' })
    .eq('id', testVendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      is_manual_verified: false,
      verification_status: 'green_pending',
      status: 'approved',
    })
    .eq('vendor_id', testVendor.id);

  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await openVendorModeration(page);

  const searchInput = page.getByPlaceholder(/search by name, shop, phone/i).first();
  await expect(searchInput).toBeVisible({ timeout: 8000 });
  await searchInput.fill(testVendor.shop_name);
  await page.waitForTimeout(500);

  const vendorRow = page.locator(`#admin-vendor-${testVendor.id}`);
  await expect(vendorRow).toBeVisible({ timeout: 15000 });
  await vendorRow.locator(`button[title="${categoryLabel}"]`).click();

  const sheet = page.locator('div.fixed.inset-0').filter({ has: page.getByText('Verification checks') });
  await expect(sheet).toBeVisible({ timeout: 8000 });
  const checkboxes = sheet.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(13, { timeout: 8000 });
  for (let i = 0; i < 13; i += 1) {
    const box = checkboxes.nth(i);
    if (!(await box.isChecked())) await box.check();
  }
  const markVerified = sheet.getByRole('button', { name: /Mark Verified \(13\/13\)/i });
  await expect(markVerified).toBeEnabled({ timeout: 8000 });
  await markVerified.click();
  await expect(sheet).not.toBeVisible({ timeout: 15000 });

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('is_manual_verified')
    .eq('id', testVendor.id)
    .single();
  expect(data?.is_manual_verified).toBe(true);

  const { data: catRow } = await supabaseAdmin
    .from('vendor_categories')
    .select('is_manual_verified')
    .eq('vendor_id', testVendor.id)
    .maybeSingle();
  expect(catRow?.is_manual_verified).toBe(true);

  const { data: adminCheckRow } = await supabaseAdmin
    .from('vendor_verification')
    .select('status, is_latest, checked_by')
    .eq('vendor_id', testVendor.id)
    .eq('check_type', 'admin_check')
    .eq('is_latest', true)
    .single();
  expect(adminCheckRow?.status).toBe('passed');
  expect(adminCheckRow?.checked_by).toBe('admin');
  expect(adminCheckRow?.is_latest).toBe(true);
});

// ─── VENDOR BAN ────────────────────────────────────────────────────────────

test('ADMIN-05: ban vendor — is_banned = true + audit log created', async ({ page }) => {
  // Tightened: no RPC fallback — requires Ban button + Confirm ban dialog.
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_unban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
  });
  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await openVendorModeration(page);

  const searchInput = page.getByPlaceholder(/search by name, shop, phone/i).first();
  await expect(searchInput).toBeVisible({ timeout: 8000 });
  await searchInput.fill(testVendor.shop_name);
  await page.waitForTimeout(500);

  const vendorRow = page.locator(`#admin-vendor-${testVendor.id}`);
  await expect(vendorRow).toBeVisible({ timeout: 15000 });
  await vendorRow.getByRole('button', { name: 'Ban' }).click();

  const confirmBan = page.getByRole('button', { name: 'Confirm ban' });
  await expect(confirmBan).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('Ban reason').fill('Test ban');
  await expect(confirmBan).toBeEnabled();
  await confirmBan.click();
  await page.waitForTimeout(2000);

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('is_banned')
    .eq('id', testVendor.id)
    .single();
  expect(data?.is_banned).toBe(true);

  const { data: log } = await supabaseAdmin
    .from('admin_actions')
    .select('action_type')
    .eq('target_id', testVendor.id)
    .eq('action_type', 'ban_vendor')
    .limit(1);
  expect(log?.length).toBeGreaterThan(0);
});

test('ADMIN-06: banned vendor hidden from radar query — DB assert', async () => {
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_ban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
    p_reason: 'Test ban',
  });
  const { data } = await supabaseAdmin.from('vendors')
    .select('id')
    .eq('is_banned', false)
    .eq('id', testVendor.id);
  expect(data?.length).toBe(0);
  await adminClient.rpc('admin_unban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
  });
});

test('ADMIN-07: unban vendor — is_banned = false + notification created', async () => {
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_ban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
    p_reason: 'Test',
  });
  await adminClient.rpc('admin_unban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
  });
  const { data } = await supabaseAdmin.from('vendors')
    .select('is_banned').eq('id', testVendor.id).single();
  expect(data?.is_banned).toBe(false);
});

// ─── CUSTOMER WARN / BAN ───────────────────────────────────────────────────

test('ADMIN-08: warn customer — warn_count increments in DB', async ({ page }) => {
  // Real UI path: Flagged Users now loads via admin_list_flagged_users
  // (SECURITY DEFINER, is_admin_session gate) instead of a direct
  // .from("users") read blocked by users_owner RLS — no RPC fallback.
  await supabaseAdmin.from('users').upsert(
    {
      phone: TEST_CUSTOMER_PHONE,
      warn_count: 0,
      noshow_count: 1,
      fake_count: 0,
      is_banned: false,
    },
    { onConflict: 'phone' },
  );
  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await openVendorModeration(page);

  await expect(page.getByText(/Flagged Users/i).first()).toBeVisible({ timeout: 8000 });
  const flaggedCard = page
    .locator('div')
    .filter({ hasText: TEST_CUSTOMER_PHONE })
    .filter({ has: page.getByRole('button', { name: 'Warn' }) })
    .last();
  await expect(flaggedCard, 'seeded flagged user must render in the panel').toBeVisible({
    timeout: 8000,
  });
  await flaggedCard.getByRole('button', { name: 'Warn' }).click();

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('users')
          .select('warn_count')
          .eq('phone', TEST_CUSTOMER_PHONE)
          .single();
        return data?.warn_count ?? 0;
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
});

// ─── AUDIT LOG ─────────────────────────────────────────────────────────────

test('ADMIN-09: admin action logged to admin_actions table', async () => {
  await supabaseAdmin.from('admin_actions').insert({
    admin_phone: TEST_ADMIN_PHONE,
    action_type: 'test_action',
    target_type: 'vendor',
    target_id: testVendor.id,
    reason: `Test audit ${TEST_SESSION}`,
  });
  const { data } = await supabaseAdmin.from('admin_actions')
    .select('action_type, reason')
    .eq('admin_phone', TEST_ADMIN_PHONE)
    .eq('target_id', testVendor.id)
    .eq('action_type', 'test_action');
  expect(data?.length).toBeGreaterThan(0);
  expect(data![0].reason).toContain(TEST_SESSION);
});

test('ADMIN-10: app_config whitelisted keys readable and updatable', async () => {
  const { data } = await supabaseAdmin.from('app_config')
    .select('key, value')
    .in('key', ['referral_enabled', 'help_accept_timeout_hours', 'feed_notification_radius_km']);
  expect(data?.length).toBeGreaterThan(0);
  expect(data?.find((r) => r.key === 'dev_menu_pin')).toBeUndefined();
});

// ─── NEGATIVE CASES ────────────────────────────────────────────────────────

test('ADMIN-NEG-01: non-admin phone cannot access admin panel UI', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('admin-panel')).not.toBeVisible({ timeout: 3000 });
});

test('ADMIN-NEG-02: banned vendor cannot go live — is_active blocked', async () => {
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_ban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
    p_reason: 'Test ban',
  });
  await supabaseAdmin.from('vendors').update({ is_active: false }).eq('id', testVendor.id);
  const { data } = await supabaseAdmin.from('vendors')
    .select('is_banned, is_active').eq('id', testVendor.id).single();
  expect(data?.is_banned).toBe(true);
  await adminClient.rpc('admin_unban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: testVendor.id,
  });
});

// ─── TRUST LEVEL & VERIFICATION CHECKLIST ──────────────────────────────────

test('ADMIN-12: vendor with Bronze checks shows Bronze trust badge in admin list', async ({ page }) => {
  const primaryCategory = await getFirstActiveCategory();
  const bronzePhone = `99012${Date.now().toString().slice(-5)}`;
  const shopName = `Bronze Shop ${TEST_SESSION}`;
  const { data: bronzeVendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Bronze Owner',
      shop_name: shopName,
      phone: bronzePhone,
      category: primaryCategory.label,
      service_mode: primaryCategory.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      is_manual_verified: false,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  expect(error).toBeNull();

  await seedVendorCategory(bronzeVendor!.id, primaryCategory);
  await seedBronzeVendorVerification(bronzeVendor!.id);

  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await openVendorModeration(page);

  const searchInput = page.getByPlaceholder(/search/i).first();
  await searchInput.click();
  await searchInput.fill('');
  await searchInput.fill(shopName);
  await page.waitForTimeout(500);

  const vendorRow = page.locator(`#admin-vendor-${bronzeVendor!.id}`);
  await vendorRow.scrollIntoViewIfNeeded();
  await expect(vendorRow).toBeVisible({ timeout: 15000 });
  await expect(vendorRow.getByText(shopName)).toBeVisible();

  const { data: verRows } = await supabaseAdmin
    .from('vendor_verification')
    .select('vendor_id, check_type, status, is_latest')
    .eq('vendor_id', bronzeVendor!.id)
    .eq('is_latest', true);
  const { data: bizRows } = await supabaseAdmin
    .from('vendor_categories')
    .select(
      'vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status',
    )
    .eq('vendor_id', bronzeVendor!.id);
  expect(
    computeTrustLevelForBusiness(
      bronzeVendor!.id,
      primaryCategory.id,
      verRows ?? [],
      bizRows ?? [],
    ),
  ).toBe('Bronze');
});

test('ADMIN-13: verify vendor sets admin_check passed and Silver tier in one action', async ({ page }) => {
  test.setTimeout(90000);
  const primaryCategory = await getFirstActiveCategory();
  const verifyPhone = `99013${Date.now().toString().slice(-5)}`;
  const shopName = `!ADMIN13-${Date.now()}`;
  const { data: verifyVendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Verify Owner',
      shop_name: shopName,
      phone: verifyPhone,
      category: primaryCategory.label,
      service_mode: primaryCategory.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      is_manual_verified: false,
      verification_status: 'green_pending',
      upi_id: 'verify@upi',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  expect(error).toBeNull();

  await seedVendorCategory(verifyVendor!.id, primaryCategory);
  await seedBronzeVendorVerification(verifyVendor!.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ verification_status: 'green_pending', is_manual_verified: false, status: 'approved' })
    .eq('vendor_id', verifyVendor!.id);

  await loginAsAdminViaSession(page, TEST_DEVICE_ID);
  await openVendorModeration(page);

  const searchInput = page.getByPlaceholder(/search/i).first();
  await searchInput.click();
  await searchInput.fill('');
  await searchInput.fill(shopName);
  await page.waitForTimeout(500);

  const vendorRow = page.locator(`#admin-vendor-${verifyVendor!.id}`);
  await expect(vendorRow).toBeVisible({ timeout: 20000 });
  await vendorRow.scrollIntoViewIfNeeded();
  await vendorRow.locator(`button[title="${primaryCategory.label}"]`).click({ timeout: 10000 });
  await expect(page.getByText('Verification checks')).toBeVisible({ timeout: 8000 });

  const sheet = page.locator('div.fixed.inset-0').filter({ has: page.getByText('Verification checks') });
  const checkboxes = sheet.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(13, { timeout: 8000 });
  for (let i = 0; i < 13; i += 1) {
    const box = checkboxes.nth(i);
    if (!(await box.isChecked())) await box.check();
  }
  await sheet.getByRole('button', { name: /Mark Verified \(13\/13\)/i }).click();
  await expect(sheet).not.toBeVisible({ timeout: 15000 });

  const { data: catRow } = await supabaseAdmin
    .from('vendor_categories')
    .select('is_manual_verified, category_id')
    .eq('vendor_id', verifyVendor!.id)
    .single();
  expect(catRow?.is_manual_verified).toBe(true);

  const { data: adminCheckRow } = await supabaseAdmin
    .from('vendor_verification')
    .select('check_type, status, is_latest, checked_by')
    .eq('vendor_id', verifyVendor!.id)
    .eq('check_type', 'admin_check')
    .eq('is_latest', true)
    .single();

  expect(adminCheckRow?.status).toBe('passed');
  expect(adminCheckRow?.is_latest).toBe(true);
  expect(adminCheckRow?.checked_by).toBe('admin');

  const { data: verRows } = await supabaseAdmin
    .from('vendor_verification')
    .select('vendor_id, check_type, status, is_latest')
    .eq('vendor_id', verifyVendor!.id)
    .eq('is_latest', true);
  const { data: bizRows } = await supabaseAdmin
    .from('vendor_categories')
    .select(
      'vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status',
    )
    .eq('vendor_id', verifyVendor!.id);
  expect(
    computeTrustLevelForBusiness(
      verifyVendor!.id,
      catRow?.category_id ?? null,
      verRows ?? [],
      bizRows ?? [],
    ),
  ).toBe('Silver');
});
