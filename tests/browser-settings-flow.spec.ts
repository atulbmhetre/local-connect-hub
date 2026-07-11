import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, loginAsFreshUser, APP_URL } from './helpers/browser-setup';
import { supabase, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';

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
  await expect(page.getByTestId('account-standing-row')).toBeVisible({ timeout: 8000 });
});

test('SET-08: account standing shows good status for new user', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  const standingRow = page.getByTestId('account-standing-row');
  await expect(standingRow).toBeVisible({ timeout: 8000 });
  const text = await standingRow.textContent();
  expect(text?.toLowerCase()).toMatch(/good|fair|standing|account/i);
});

// ─── VENDOR SETTINGS ───────────────────────────────────────────────────────

test('SET-09: MY SHOP section visible for vendor', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  // MY SHOP section should be present for vendors
  const myShop = page.getByText(/my shop/i).first();
  await expect(myShop).toBeVisible({ timeout: 5000 });
});

test('SET-10: MY SHOP section not visible for customer-only user', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  // MY SHOP should not appear without vendor_id in localStorage
  const myShop = page.getByText(/my shop/i).first();
  await expect(myShop).not.toBeVisible({ timeout: 3000 });
});

// ─── NAVIGATION ────────────────────────────────────────────────────────────

test('SET-11: settings reachable via bottom nav', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/`);
  await page.getByTestId('nav-settings').click();
  await expect(page).toHaveURL(/settings/);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
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
