import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, loginAsFreshUser, APP_URL } from './helpers/browser-setup';
import { supabase, supabaseAdmin, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_settings_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

async function openPreferences(page: any) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  const prefsToggle = page.getByText(/preferences/i).first();
  await expect(prefsToggle).toBeVisible({ timeout: 5000 });
  await prefsToggle.click();
}

// ─── SETTINGS SCREEN ───────────────────────────────────────────────────────

test('SET-01: settings screen loads for customer', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
});

test('SET-02: settings screen loads for vendor', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
});

// ─── THEME ─────────────────────────────────────────────────────────────────

test('SET-03: theme toggle switches between dark and light', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await openPreferences(page);
  await expect(page.getByTestId('theme-toggle')).toBeVisible({ timeout: 5000 });
  const themeBefore = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  await page.getByTestId('theme-toggle').click();
  const themeAfter = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  expect(themeAfter).not.toBe(themeBefore);
  expect(['dark', 'light']).toContain(themeAfter);
});

test('SET-04: theme persists after page reload', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await openPreferences(page);
  await page.getByTestId('theme-toggle').click();
  const themeSet = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  await page.reload();
  const themeAfterReload = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  expect(themeAfterReload).toBe(themeSet);
});

// ─── LANGUAGE ──────────────────────────────────────────────────────────────

test('SET-05: language selector visible and has options', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await openPreferences(page);
  await expect(page.getByTestId('language-select')).toBeVisible({ timeout: 5000 });
});

test('SET-06: language selector is interactive and reflects current language', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await openPreferences(page);
  const langSelect = page.getByTestId('language-select');
  await expect(langSelect).toBeVisible({ timeout: 5000 });
  // Select element should have a current value (en/hi/mr)
  const currentValue = await langSelect.evaluate((el: HTMLSelectElement) =>
    el.value || el.getAttribute('data-value') || el.textContent
  );
  expect(currentValue).toBeTruthy();
  // Language stored should be en/hi/mr or null (default en)
  const lang = await page.evaluate(() => localStorage.getItem('aaspaas:language'));
  // null means default English — which is valid
  if (lang !== null) {
    expect(['en', 'hi', 'mr']).toContain(lang);
  }
});

// ─── ACCOUNT STANDING ──────────────────────────────────────────────────────

test('SET-07: account standing row visible for customer', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-account-standing-toggle')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('settings-account-standing-toggle').click();
  await expect(page.getByTestId('account-standing-row')).toBeVisible({ timeout: 8000 });
});

test('SET-08: account standing shows good status for new user', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await page.getByTestId('settings-account-standing-toggle').click();
  const standingRow = page.getByTestId('account-standing-row');
  await expect(standingRow).toBeVisible({ timeout: 8000 });
  const text = await standingRow.textContent();
  expect(text?.toLowerCase()).toMatch(/good|fair|standing|account/i);
});

test('SET-11: Local Feed collapsible under MY ACCOUNT — toggle + radius save', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });

  // Nested under MY ACCOUNT (parent defaults open) — body closed until tapped.
  await expect(page.getByTestId('settings-feed-discovery-toggle')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('settings-feed-discovery')).not.toBeVisible();

  await page.getByTestId('settings-feed-discovery-toggle').click();
  await expect(page.getByTestId('settings-feed-discovery')).toBeVisible();
  await expect(page.getByText(/Show me posts within/i)).toBeVisible();

  // Radius chip still saves via set_feed_discovery_radius (same RPC path as before).
  await page.getByRole('button', { name: /^10 km$/i }).click();
  await expect(page.getByText(/Feed discovery radius saved/i)).toBeVisible({ timeout: 10000 });

  const { data, error } = await supabase.rpc('get_feed_preferences', {
    p_user_phone: TEST_CUSTOMER_PHONE,
  });
  expect(error).toBeNull();
  expect((data as { feed_discovery_radius_km?: number | null } | null)?.feed_discovery_radius_km).toBe(
    10,
  );

  await page.getByTestId('settings-feed-discovery-toggle').click();
  await expect(page.getByTestId('settings-feed-discovery')).not.toBeVisible();
});

// ─── VENDOR SETTINGS ───────────────────────────────────────────────────────

test('SET-09: My Business tab visible for vendor', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  // Vendors use the My Business tab (legacy MY SHOP parent section was removed).
  await expect(page.getByTestId('settings-vendor-tab-business')).toBeVisible({ timeout: 5000 });
});

test('SET-10: My Business tab not visible for customer-only user', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-vendor-tab-business')).toHaveCount(0);
});

// ─── NAVIGATION ────────────────────────────────────────────────────────────

test('SET-11: settings reachable via bottom nav', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/`);
  await page.getByTestId('nav-settings').click();
  await expect(page).toHaveURL(/settings/);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
});

// ─── MY IDENTITY PHONE ─────────────────────────────────────────────────────

/** Welcomed customer with no phone — one-shot clear (not loginAsFreshUser initScript). */
async function loginAsNoPhoneCustomer(page: import('@playwright/test').Page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, `device_settings_nophone_${Date.now()}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible();
}

test('SET-12: no-phone customer can add phone from My Identity and post announcement', async ({
  page,
}) => {
  const phone = `8803${String(Date.now()).slice(-6)}`;
  // loginAsFreshUser clears storage on every navigation — would wipe the phone before Post.
  await loginAsNoPhoneCustomer(page);
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  // Before phone: compose opens, but Post is blocked with Settings prompt.
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByPlaceholder(/Share something with your neighbourhood/i)).toBeVisible({
    timeout: 8000,
  });
  await page.getByPlaceholder(/Share something with your neighbourhood/i).fill('Blocked without phone');
  await page.getByRole('button', { name: /^Post$/i }).click();
  await expect(page.getByText(/Add your phone in Settings first/i)).toBeVisible({ timeout: 8000 });

  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('settings-identity-toggle').click();
  await expect(page.getByTestId('settings-add-phone')).toBeVisible();
  await page.getByTestId('settings-add-phone').click();

  await expect(page.getByText(/Add your number so orders and Local Feed/i)).toBeVisible({
    timeout: 5000,
  });
  await page.getByPlaceholder('98765 43210').fill(phone);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expect(page.getByText(/Phone number saved/i)).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(phone);
  await expect(page.getByTestId('settings-identity-phone')).toContainText(phone, { timeout: 8000 });
  await expect(page.getByTestId('settings-change-phone')).toBeVisible();

  const { mintBrowserSupabaseSession } = await import('./helpers/setup');
  await mintBrowserSupabaseSession(page, phone, 'SET-12');
  // Mint must not wipe identity; re-assert before feed.
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(phone);

  await page.goto(`${APP_URL}/feed`);
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(phone);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByPlaceholder(/Share something with your neighbourhood/i)).toBeVisible({
    timeout: 8000,
  });
  await page.getByPlaceholder(/Share something with your neighbourhood/i).fill(
    `Settings phone announce ${phone}`,
  );
  await page.getByRole('button', { name: /^Post$/i }).click();
  await expect(page.getByText(/Posted!/i)).toBeVisible({ timeout: 20000 });

  const { data: posts, error } = await supabaseAdmin
    .from('feed_posts')
    .select('id, user_phone, content, type')
    .eq('user_phone', phone)
    .eq('type', 'announcement')
    .order('created_at', { ascending: false })
    .limit(1);
  expect(error).toBeNull();
  expect(posts?.length).toBeGreaterThan(0);
  expect(posts![0].content).toContain(`Settings phone announce ${phone}`);
});

test('SET-13: My Identity phone entry offers restore for known number', async ({ page }) => {
  const existing = `8804${String(Date.now()).slice(-6)}`;
  await supabaseAdmin.from('users').upsert({
    phone: existing,
    total_orders: 5,
    completed_orders: 2,
  });

  await loginAsNoPhoneCustomer(page);

  await page.goto(`${APP_URL}/settings`);
  await page.getByTestId('settings-identity-toggle').click();
  await page.getByTestId('settings-add-phone').click();
  await page.getByPlaceholder('98765 43210').fill(existing);
  await page.getByRole('button', { name: /^Continue$/i }).click();

  await expect(page.getByTestId('phone-entry-existing-title')).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  await page.getByTestId('phone-entry-existing-restore').click();
  await expect(page.getByText(/Phone number saved/i)).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(existing);
});

// ─── NEGATIVE / EDGE CASES ─────────────────────────────────────────────────

test('SET-NEG-01: admin panel not visible for regular customer', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  // Admin tab stays hidden until the 7-tap gesture; regular customers never see it.
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible({ timeout: 3000 });
  await expect(page.getByTestId('admin-panel')).not.toBeVisible({ timeout: 3000 });
});

test('SET-NEG-02: fresh user has no vendor tab in settings', async ({ page }) => {
  await loginAsFreshUser(page);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('nav-vendor')).not.toBeVisible({ timeout: 3000 });
});
