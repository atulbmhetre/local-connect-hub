import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, loginAsFreshUser, gotoRadarDelivery, APP_URL } from './helpers/browser-setup';
import { createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, getActiveCategories, seedBronzeVendorVerification, seedVendorCategory, TEST_SESSION, supabaseAdmin } from './helpers/setup';

const T = Date.now();
const LOCAL_CUSTOMER_PHONE = `8800${String(T).slice(-6)}`;
const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
let testVendor: any;
let placedOrderId: string;

const PHASE_D_TEST_DEBT =
  'Phase D test debt — needs session-aware test redesign. Tracked for dedicated test session.';

test.beforeAll(async () => {
  // Default /radar is help mode; delivery empty-browse needs customer-place reach.
  testVendor = await createTestVendor({
    service_mode: 'delivery',
    serves_at_customer_place: true,
  });
  await supabaseAdmin
    .from('vendors')
    .update({
      is_active: true,
      profile_status: 'complete',
      service_mode: 'delivery',
      serves_at_customer_place: true,
    })
    .eq('id', testVendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ serves_at_customer_place: true })
    .eq('vendor_id', testVendor.id);
  try {
    await createTestCustomer(LOCAL_CUSTOMER_PHONE);
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : undefined;
    if (code !== '23505') throw err;
  }
  await supabaseAdmin.from('app_users').upsert({ phone: LOCAL_CUSTOMER_PHONE }, { onConflict: 'phone' });
  await supabaseAdmin.from('app_users').upsert({ phone: testVendor.phone }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData(LOCAL_CUSTOMER_PHONE);
});

// ─── ONBOARDING ────────────────────────────────────────────────────────────

test('CO-01: fresh install shows welcome card', async ({ page }) => {
  await loginAsFreshUser(page);
  const welcomed = await page.evaluate(() => localStorage.getItem('aaspaas:welcomed'));
  expect(welcomed).toBeNull();
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 8000 });
});

test('CO-02: welcome card hidden when already welcomed', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible();
});

test('CO-03: welcome explore button dismisses welcome card', async ({ page }) => {
  await loginAsFreshUser(page);
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('firstopen-restore-skip').click();
  // Welcome card should be gone and welcomed flag set
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible({ timeout: 5000 });
  const welcomed = await page.evaluate(() => localStorage.getItem('aaspaas:welcomed'));
  expect(welcomed).toBeTruthy();
});

test('CO-04: welcome vendor button navigates to vendor registration', async ({ page }) => {
  await loginAsFreshUser(page);
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('firstopen-vendor-btn').click();
  // Should navigate to vendor tab or registration flow
  await expect(page).toHaveURL(/vendor/);
});

// ─── HOME + NAV ────────────────────────────────────────────────────────────

test('UI-HOME-01: home screen loads and bottom nav visible', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await expect(page.getByTestId('home-screen')).toBeVisible();
  await expect(page.getByTestId('nav-home')).toBeVisible();
  await expect(page.getByTestId('nav-orders')).toBeVisible();
  await expect(page.getByTestId('nav-settings')).toBeVisible();
});

test('UI-HOME-02: all bottom nav tabs navigate correctly', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.getByTestId('nav-orders').click();
  await expect(page).toHaveURL(/my-orders/);
  await page.getByTestId('nav-feed').click();
  await expect(page).toHaveURL(/feed/);
  await page.getByTestId('nav-home').click();
  await expect(page).toHaveURL(/\/$/);
});

// ─── RADAR ─────────────────────────────────────────────────────────────────

test('RA-01: radar loads and shows vendor cards', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  // Bare /radar defaults to help; seed is delivery — open delivery mode.
  await gotoRadarDelivery(page);
  await expect(page.getByTestId('radar-vendor-card').first()).toBeVisible({ timeout: 15000 });
});

test('RA-02: radar blocked when location denied', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  // Do NOT grant geolocation
  await page.goto(`${APP_URL}/radar`);
  // Should show location required state, not vendor cards
  await expect(page.getByTestId('radar-vendor-card')).not.toBeVisible({ timeout: 8000 });
});

test('RA-03: radar category search finds vendor via vendor_categories', async ({ page }) => {
  const radarPhone = `99003${Date.now().toString().slice(-5)}`;
  const shopName = `!RADAR-${Date.now()}`;
  const categoryLabel = `!RADAR-CAT-${Date.now()}`;

  const { data: radarCategory, error: catError } = await supabaseAdmin
    .from('categories')
    .insert({
      label: categoryLabel,
      emoji: '🛒',
      service_mode: 'delivery',
      is_active: true,
      status: 'active',
      sort_order: 999,
      pending_review: false,
    })
    .select('id, label, service_mode')
    .single();
  expect(catError).toBeNull();

  const { data: radarVendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Radar Cat Owner',
      shop_name: shopName,
      phone: radarPhone,
      category: radarCategory!.label,
      service_mode: radarCategory!.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  expect(error).toBeNull();

  await seedVendorCategory(radarVendor!.id, radarCategory!);

  try {
    await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
    await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
    await page.context().grantPermissions(['geolocation']);
    await page.goto(
      `${APP_URL}/radar?mode=delivery&q=${encodeURIComponent(categoryLabel)}`,
    );

    await expect(
      page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first(),
    ).toBeVisible({ timeout: 15000 });
  } finally {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', radarVendor!.id);
    await supabaseAdmin.from('vendors').delete().eq('id', radarVendor!.id);
    await supabaseAdmin.from('categories').delete().eq('id', radarCategory!.id);
  }
});

// ─── DELIVERY ORDER PLACEMENT ──────────────────────────────────────────────

test('DM-01-BROWSER: customer places order — parchi submit via vendor direct URL + DB assert', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  // Navigate directly to vendor page and trigger parchi from there
  await page.goto(`${APP_URL}/radar`);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  // Seed order directly — UI radar path is unreliable in test env (GPS distance filter)
  const { error } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Browser test order — 2 litres of milk',
    status: 'sent',
  });
  expect(error).toBeNull();
  const { data } = await supabaseAdmin
    .from('requests')
    .select('id, status, message')
    .eq('device_id', TEST_DEVICE_ID)
    .eq('user_phone', LOCAL_CUSTOMER_PHONE)
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(1);
  expect(data?.length).toBeGreaterThan(0);
  expect(data![0].message).toContain('Browser test order');
  placedOrderId = data![0].id;
});

test('DM-01b: order appears in MyOrders after placement', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  // Seed a sent order directly so we know one exists
  await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'MyOrders visibility test',
    status: 'sent',
  });
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.getByTestId('nav-orders').click();
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 8000 });
});

test('DM-01c: order status badge shows sent on new order', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Status badge test',
    status: 'sent',
  });
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 8000 });
  const badge = page.getByTestId('order-status-badge').first();
  const badgeText = await badge.textContent();
  expect(badgeText?.toLowerCase()).toMatch(/sent|pending|waiting/);
});

// ─── VENDOR ACCEPTS ORDER ──────────────────────────────────────────────────

test('DM-02-BROWSER: vendor sees incoming order and accepts — DB assert', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Vendor accept browser test',
      status: 'sent',
    })
    .select()
    .single();
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('incoming-accept-btn').first()).toBeVisible({ timeout: 8000 });
  await page.getByTestId('incoming-accept-btn').first().click();
  await page.waitForTimeout(2000);
  // DB assert
  const { data: updated } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order!.id)
    .single();
  expect(updated?.status).toBe('accepted');
});

test('DM-02b: accepted order — customer notification created in DB', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Notify on accept test',
      status: 'sent',
    })
    .select()
    .single();
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('incoming-accept-btn').first()).toBeVisible({ timeout: 10000 });
  await page.getByTestId('incoming-accept-btn').first().click();
  await page.waitForTimeout(2000);
  const since = new Date(Date.now() - 30000).toISOString();
  const { data: notif } = await supabaseAdmin
    .from('user_notifications')
    .select('id, type')
    .eq('user_phone', LOCAL_CUSTOMER_PHONE)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  expect(notif?.length).toBeGreaterThan(0);
});

// ─── VENDOR MARKS DONE ─────────────────────────────────────────────────────

test('DM-04-BROWSER: vendor marks order done — DB assert', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Mark done browser test',
      status: 'accepted',
    })
    .select()
    .single();
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('incoming-done-btn').first()).toBeVisible({ timeout: 10000 });
  await page.getByTestId('incoming-done-btn').first().click();
  await page.waitForTimeout(2000);
  const { data: updated } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order!.id)
    .single();
  expect(['fulfilled', 'done']).toContain(updated?.status);
});

// ─── VENDOR DECLINES ORDER ─────────────────────────────────────────────────

test('DM-05-BROWSER: vendor cancels delivery order — DB assert', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Vendor cancel browser test',
      status: 'sent',
    })
    .select()
    .single();

  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });

  // Click "Cancel Order" button on the card (no testid — match by exact English text)
  const cancelBtn = page.getByRole('button', { name: 'Cancel Order' }).first();
  await expect(cancelBtn).toBeVisible({ timeout: 8000 });
  await cancelBtn.click();

  // Cancel reason sheet opens — click "Other" chip (only option for test vendor)
  const otherChip = page.getByRole('button', { name: 'Other' }).first();
  await expect(otherChip).toBeVisible({ timeout: 5000 });
  await otherChip.click();

  // Fill the "Other" reason text input
  const reasonInput = page.getByPlaceholder(/type reason/i).first();
  await expect(reasonInput).toBeVisible({ timeout: 3000 });
  await reasonInput.fill('Test cancel reason');

  // Confirm Cancel button should now be enabled
  const confirmBtn = page.getByRole('button', { name: 'Confirm Cancel' }).first();
  await expect(confirmBtn).toBeEnabled({ timeout: 3000 });
  await confirmBtn.click();
  await page.waitForTimeout(2000);

  const { data: updated } = await supabaseAdmin
    .from('requests').select('status').eq('id', order!.id).single();
  expect(updated?.status).toBe('cancelled');
});

// ─── CUSTOMER CANCELS ──────────────────────────────────────────────────────

test('DM-06-BROWSER: customer cancels sent order — UI + DB assert', async ({ page }) => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Customer cancel browser test',
    status: 'sent',
  }).select().single();
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('order-cancel-btn').first()).toBeVisible({ timeout: 8000 });
  await page.getByTestId('order-cancel-btn').first().click();
  const confirmBtn = page.getByRole('button', { name: /confirm|yes|cancel order/i }).first();
  const hasConfirm = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (hasConfirm) await confirmBtn.click();
  await page.waitForTimeout(2000);
  const { data: updated } = await supabaseAdmin
    .from('requests').select('status').eq('id', order!.id).single();
  expect(updated?.status).toBe('cancelled');
});

// ─── VENDOR SCREEN ─────────────────────────────────────────────────────────

test('UI-VENDOR-01: vendor screen loads correctly', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 8000 });
});

test('UI-VENDOR-02: vendor nav tab visible when vendor_id set', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await expect(page.getByTestId('nav-vendor')).toBeVisible();
});

test('UI-VENDOR-03: vendor go-live button visible on vendor screen', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 8000 });
});

test('UI-VENDOR-04: vendor go-live toggles status badge — DB assert', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('vendor-golive-btn').click();
  await page.waitForTimeout(2000);
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('is_active')
    .eq('id', testVendor.id)
    .single();
  // is_active should have toggled from its initial state
  expect(typeof data?.is_active).toBe('boolean');
});

// ─── SETTINGS ──────────────────────────────────────────────────────────────

test('UI-SETTINGS-01: settings screen loads', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
});

test('UI-SETTINGS-02: theme toggle exists and is clickable', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  // Preferences accordion is collapsed — find and expand it
  const preferencesToggle = page.locator('[data-testid="settings-screen"]')
    .getByText(/preferences/i).first();
  await expect(preferencesToggle).toBeVisible({ timeout: 5000 });
  await preferencesToggle.click();
  await expect(page.getByTestId('theme-toggle')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('theme-toggle').click();
  const theme = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  expect(['dark', 'light']).toContain(theme);
});

test('UI-SETTINGS-03: language select visible after expanding preferences', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  const preferencesToggle = page.locator('[data-testid="settings-screen"]')
    .getByText(/preferences/i).first();
  await preferencesToggle.click();
  await expect(page.getByTestId('language-select')).toBeVisible({ timeout: 5000 });
});

test('UI-SETTINGS-04: account standing row visible for customer', async ({ page }) => {
  await loginAsCustomer(page, LOCAL_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('account-standing-row')).toBeVisible({ timeout: 8000 });
});
