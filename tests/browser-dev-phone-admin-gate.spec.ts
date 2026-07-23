import { test, expect } from '@playwright/test';
import {
  loginAsAdmin,
  loginAsCustomer,
  revealAdminTab,
  waitForSettingsAdminReady,
  APP_URL,
} from './helpers/browser-setup';
import { TEST_CUSTOMER_PHONE } from './helpers/setup';

const DEVICE_ID = `dev-phone-gate-${Date.now()}`;

test('DEV-PHONE-01: non-admin cannot see phone override after 7-tap (no PIN path)', async ({
  page,
}) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await revealAdminTab(page);

  await expect(page.getByRole('alertdialog').filter({ hasText: /Developer PIN/i })).toHaveCount(0);
  await expect(page.getByTestId('admin-dev-phone-override')).toHaveCount(0);
  await expect(page.getByTestId('admin-dev-phone-input')).toHaveCount(0);

  await page.getByTestId('settings-tab-admin').click();
  await expect(page.getByTestId('admin-login-gate')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('admin-dev-phone-override')).toHaveCount(0);
});

test('DEV-PHONE-02: admin session can use phone override control', async ({ page }) => {
  await loginAsAdmin(page, `${DEVICE_ID}-admin`);
  await expect(page.getByTestId('admin-panel')).toBeVisible();
  await expect(page.getByTestId('admin-dev-phone-override')).toBeVisible();
  await expect(page.getByTestId('admin-dev-phone-input')).toBeVisible();
  await expect(page.getByTestId('admin-dev-phone-save')).toBeVisible();

  const probePhone = `88007${Date.now().toString().slice(-5)}`;
  await page.getByTestId('admin-dev-phone-input').fill(probePhone);
  await page.getByTestId('admin-dev-phone-save').click();

  await page.waitForURL(/\/settings/, { timeout: 15000 });
  await waitForSettingsAdminReady(page);

  const stored = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(stored).toBe(probePhone);
});
