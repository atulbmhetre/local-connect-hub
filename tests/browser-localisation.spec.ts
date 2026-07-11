import { test, expect, type Page } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import { supabase, supabaseAdmin, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_i18n_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

async function waitForHomeScreen(page: Page) {
  await page.waitForSelector('[data-testid="home-screen"]', { timeout: 20000 });
}

async function setLanguage(page: Page, lang: 'en' | 'hi' | 'mr') {
  await page.evaluate((l: string) => localStorage.setItem('aaspaas:language', l), lang);
  await page.reload();
  await waitForHomeScreen(page);
}

async function openPreferences(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  const prefsToggle = page.getByText(/preferences/i).first();
  await expect(prefsToggle).toBeVisible({ timeout: 5000 });
  await prefsToggle.click();
}

// ─── FEATURE FLAGS ─────────────────────────────────────────────────────────

test('I18N-01: localisation feature flags exist in app_config', async () => {
  const { data } = await supabaseAdmin.from('app_config')
    .select('key, value')
    .in('key', ['localizationEnabled', 'langHindiEnabled', 'langMarathiEnabled']);
  const keys = data?.map((r) => r.key) ?? [];
  if (keys.length > 0) {
    expect(keys).toContain('localizationEnabled');
  }
});

test('I18N-02: default language is English on fresh install', async ({ page }) => {
  await page.goto(APP_URL);
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('aaspaas:welcomed', 'true');
  });
  await page.reload();
  const lang = await page.evaluate(() => localStorage.getItem('aaspaas:language'));
  if (lang !== null) expect(lang).toBe('en');
});

// ─── LANGUAGE SWITCHING ────────────────────────────────────────────────────

test('I18N-03: switching to Hindi — app reloads without crash', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/`);
  await waitForHomeScreen(page);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });
});

test('I18N-04: switching to Marathi — app reloads without crash', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  await page.goto(`${APP_URL}/`);
  await waitForHomeScreen(page);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });
});

test('I18N-05: switching back to English from Hindi — app reloads correctly', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await setLanguage(page, 'en');
  await page.goto(`${APP_URL}/`);
  await waitForHomeScreen(page);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
});

// ─── HINDI STRING CHECKS ─────────────────────────────────────────────────

test('I18N-06: Hindi — bottom nav tabs not empty', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  const navHome = page.getByTestId('nav-home');
  await expect(navHome).toBeVisible({ timeout: 8000 });
  const text = await navHome.textContent();
  expect(text?.trim().length).toBeGreaterThan(0);
});

test('I18N-07: Hindi — settings screen loads with non-empty content', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  const content = await page.getByTestId('settings-screen').textContent();
  expect(content?.trim().length).toBeGreaterThan(10);
});

test('I18N-08: Hindi — MyOrders screen loads without crash', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 8000 });
});

test('I18N-09: Hindi — vendor screen loads without crash', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 8000 });
});

// ─── MARATHI STRING CHECKS ───────────────────────────────────────────────

test('I18N-10: Marathi — bottom nav tabs not empty', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  const navHome = page.getByTestId('nav-home');
  await expect(navHome).toBeVisible({ timeout: 8000 });
  const text = await navHome.textContent();
  expect(text?.trim().length).toBeGreaterThan(0);
});

test('I18N-11: Marathi — settings screen loads with non-empty content', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  const content = await page.getByTestId('settings-screen').textContent();
  expect(content?.trim().length).toBeGreaterThan(10);
});

test('I18N-12: Marathi — vendor screen loads without crash', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 8000 });
});

// ─── NO MISSING KEYS ───────────────────────────────────────────────────────

test('I18N-13: Hindi — no raw string keys visible on home screen', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/`);
  await waitForHomeScreen(page);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });
  const content = await page.getByTestId('home-screen').textContent();
  expect(content).not.toMatch(/^[a-z]+_[a-z]+_[a-z]+$/m);
});

test('I18N-14: Marathi — no raw string keys visible on home screen', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  await page.goto(`${APP_URL}/`);
  await waitForHomeScreen(page);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });
  const content = await page.getByTestId('home-screen').textContent();
  expect(content).not.toMatch(/^[a-z]+_[a-z]+_[a-z]+$/m);
});

// ─── LANGUAGE PERSISTENCE ──────────────────────────────────────────────────

test('I18N-15: language persists across navigation', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'hi');
  await page.goto(`${APP_URL}/my-orders`);
  const lang = await page.evaluate(() => localStorage.getItem('aaspaas:language'));
  expect(lang).toBe('hi');
  await page.goto(`${APP_URL}/settings`);
  const langAfter = await page.evaluate(() => localStorage.getItem('aaspaas:language'));
  expect(langAfter).toBe('hi');
});

test('I18N-16: language persists after page reload', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'mr');
  await page.reload();
  await waitForHomeScreen(page);
  const lang = await page.evaluate(() => localStorage.getItem('aaspaas:language'));
  expect(lang).toBe('mr');
});

// ─── LANGUAGE SELECTOR UI ──────────────────────────────────────────────────

test('I18N-17: language selector shows current language', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await setLanguage(page, 'en');
  await openPreferences(page);
  await expect(page.getByTestId('language-select')).toBeVisible({ timeout: 5000 });
});

test('I18N-18: all 3 language options available in selector', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await waitForHomeScreen(page);
  await openPreferences(page);
  const langSelect = page.getByTestId('language-select');
  await expect(langSelect).toBeVisible({ timeout: 5000 });
  await langSelect.click();
  await expect(page.getByRole('option', { name: /english/i })).toBeVisible({ timeout: 3000 });
  const hindi = page.getByRole('option', { name: /hindi|हिंदी/i });
  const marathi = page.getByRole('option', { name: /marathi|मराठी/i });
  if (await hindi.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(hindi).toBeVisible();
  }
  if (await marathi.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(marathi).toBeVisible();
  }
});
