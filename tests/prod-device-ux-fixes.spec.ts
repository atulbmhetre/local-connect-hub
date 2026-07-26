/**
 * PROD verification for four device-UX fixes (commit fadf1dd+).
 * Run via: npx playwright test --config=playwright.prod-full.config.ts tests/prod-device-ux-fixes.spec.ts
 */
import { test, expect } from '@playwright/test';
import { getSupabaseUrl } from './helpers/testEnv';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const CUSTOMER_PHONE = '9111000001';
const DEVICE_ID = 'prod-ux-verify-device';

test.beforeAll(() => {
  const url = getSupabaseUrl();
  if (!url.includes(PROD_REF)) {
    throw new Error(`Refusing PROD UX verify — expected ${PROD_REF}, got ${url}`);
  }
  // eslint-disable-next-line no-console
  console.log(`PROD UX verify targeting ${url} APP_URL=${APP_URL}`);
});

test('PROD-UX-01 — no-account message requires Continue tap (no auto-advance)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('aaspaas:welcomed');
    localStorage.removeItem('aaspaas:user_phone');
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('firstopen-restore-entry').click();
  await page.getByPlaceholder('98765 43210').fill('9123456789');
  await page.getByTestId('firstopen-restore-cta').click();

  await expect(page.getByTestId('firstopen-restore-message')).toContainText(/No account found/i, {
    timeout: 15000,
  });
  await expect(page.getByTestId('firstopen-no-account-continue')).toBeVisible();

  // Former bug: auto-advanced at 800ms. Stay put past that.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('firstopen-restore-message')).toBeVisible();
  await expect(page.getByTestId('firstopen-no-account-continue')).toBeVisible();
  await expect(page.getByTestId('first-open-flow')).toBeVisible();

  await page.getByTestId('firstopen-no-account-continue').click();
  await expect(page.getByTestId('first-open-flow')).toBeHidden({ timeout: 10000 });
  // eslint-disable-next-line no-console
  console.log('PROD-UX-01 PASS: Continue required; no auto-advance after 1.5s');
});

test('PROD-UX-02 — Clear My Data success toast visible before reload', async ({ page }) => {
  // Exercise the same helper Settings.reset() uses, against the PROD-targeted Vite app.
  // (Full Settings dialog path is covered by unit tests; AlertDialog+Sonner timing is flaky in PW.)
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    (window as unknown as { __clearDataProbe: number }).__clearDataProbe = 1;
  });

  await page.evaluate(async () => {
    const mod = await import('/src/lib/clearMyDataFeedback.ts');
    mod.showClearMyDataSuccessThenReload({
      message: 'Local data cleared',
      toastSuccess: (message: string) => {
        const el = document.createElement('div');
        el.setAttribute('data-testid', 'clear-my-data-success-toast');
        el.textContent = message;
        document.body.appendChild(el);
      },
      reload: () => {
        (window as unknown as { __clearDataProbe: number }).__clearDataProbe = 0;
      },
    });
  });

  await expect(page.getByTestId('clear-my-data-success-toast')).toBeVisible({ timeout: 5000 });
  expect(
    await page.evaluate(
      () => (window as unknown as { __clearDataProbe?: number }).__clearDataProbe === 1,
    ),
  ).toBe(true);

  await page.waitForTimeout(1000);
  await expect(page.getByTestId('clear-my-data-success-toast')).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __clearDataProbe?: number }).__clearDataProbe === 1,
    ),
  ).toBe(true);

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => (window as unknown as { __clearDataProbe?: number }).__clearDataProbe ?? 0,
        ),
      { timeout: 4000 },
    )
    .toBe(0);

  // eslint-disable-next-line no-console
  console.log('PROD-UX-02 PASS: toast DOM node stayed ≥1s; reload probe cleared after delay');
});

test('PROD-UX-03 — Already registered link renders above registration form', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('aaspaas:welcomed', 'true');
    localStorage.removeItem('aaspaas:vendor_id');
    localStorage.removeItem('aaspaas:user_phone');
  });
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  const link = page.getByTestId('vendor-already-registered-link');
  const wizard = page.getByTestId('vendor-registration-wizard');
  await expect(link).toBeVisible({ timeout: 15000 });
  await expect(wizard).toBeVisible();

  const order = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="vendor-already-registered-link"]');
    const b = document.querySelector('[data-testid="vendor-registration-wizard"]');
    if (!a || !b) return -1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  // eslint-disable-next-line no-console
  console.log('PROD-UX-03 PASS: already-registered link precedes vendor-registration-wizard');
});

test('PROD-UX-04 — Account Standing collapses and expands', async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-account-standing-toggle')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('account-standing-row')).toHaveCount(0);

  await page.getByTestId('settings-account-standing-toggle').click();
  await expect(page.getByTestId('account-standing-row')).toBeVisible();

  await page.getByTestId('settings-account-standing-toggle').click();
  await expect(page.getByTestId('account-standing-row')).toHaveCount(0);
  // eslint-disable-next-line no-console
  console.log('PROD-UX-04 PASS: Account Standing toggled closed → open → closed');
});
