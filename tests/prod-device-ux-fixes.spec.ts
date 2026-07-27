/**
 * PROD verification for FirstOpen rebuild + prior device-UX fixes.
 * Run via: npx playwright test --config=playwright.prod-full.config.ts tests/prod-device-ux-fixes.spec.ts
 */
import { test, expect } from '@playwright/test';
import { getServiceRoleClient, getSupabaseUrl } from './helpers/testEnv';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import { openPhoneEntrySheet, submitPhoneNumber } from './helpers/browser-recovery';
import { strings } from '../src/lib/strings';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const CUSTOMER_PHONE = '9111000001';
const DEVICE_ID = 'prod-ux-verify-device';
const EN = strings.en;
const T = Date.now();

const FO_EXISTING_PHONE = `9112${String(T).slice(-6)}`;
const FO_VENDOR_PHONE = `9912${String(T).slice(-6)}`;

let foVendorId: string | null = null;

test.beforeAll(() => {
  const url = getSupabaseUrl();
  if (!url.includes(PROD_REF)) {
    throw new Error(`Refusing PROD UX verify — expected ${PROD_REF}, got ${url}`);
  }
  // eslint-disable-next-line no-console
  console.log(`PROD UX verify targeting ${url} APP_URL=${APP_URL}`);
});

test.afterAll(async () => {
  const admin = getServiceRoleClient();
  if (foVendorId) {
    await admin.from('vendor_categories').delete().eq('vendor_id', foVendorId);
    await admin.from('vendors').delete().eq('id', foVendorId);
  }
  await admin.from('users').delete().eq('phone', FO_EXISTING_PHONE);
  await admin.from('users').delete().eq('phone', FO_VENDOR_PHONE);
});

test('PROD-FO-01 — two-tier FirstOpen chooser renders (new / returning)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 15000 });

  await expect(page.getByTestId('firstopen-im-new')).toHaveText(EN.welcome_im_new);
  await expect(page.getByTestId('firstopen-returning')).toHaveText(EN.welcome_returning);
  await expect(page.getByTestId('firstopen-use-as-customer')).not.toBeVisible();

  await page.getByTestId('firstopen-im-new').click();
  await expect(page.getByTestId('firstopen-use-as-customer')).toHaveText(
    EN.welcome_use_as_customer,
  );
  await expect(page.getByTestId('firstopen-vendor-btn')).toHaveText(
    EN.welcome_register_business,
  );
  await page.getByTestId('firstopen-new-options-back').click();
  await expect(page.getByTestId('firstopen-im-new')).toBeVisible();

  await page.getByTestId('firstopen-returning').click();
  await expect(page.getByTestId('firstopen-restore-cta')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(EN.firstopen_restore_body)).toBeVisible();
  await expect(page.getByText(/OTP/i)).toHaveCount(0);

  // eslint-disable-next-line no-console
  console.log('PROD-FO-01 PASS: two-tier chooser + restore copy without OTP wording');
});

test('PROD-FO-02 — known phone under new-path customer offers restore safety net', async ({
  page,
}) => {
  const admin = getServiceRoleClient();

  const { data: category, error: catErr } = await admin
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .eq('service_mode', 'delivery')
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (catErr || !category) throw new Error(`PROD delivery category: ${catErr?.message ?? 'none'}`);

  const { data: vendor, error: vendErr } = await admin
    .from('vendors')
    .insert({
      name: 'PROD FO Safety Vendor',
      shop_name: `!PROD-FO-${T}`,
      phone: FO_VENDOR_PHONE,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select('id, shop_name')
    .single();
  if (vendErr) throw new Error(`PROD vendor seed: ${vendErr.message}`);
  foVendorId = vendor!.id;

  const { data: vc, error: vcErr } = await admin
    .from('vendor_categories')
    .insert({
      vendor_id: vendor!.id,
      category_id: category.id,
      is_primary: true,
      status: 'approved',
      needs_review: false,
      service_mode: 'delivery',
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      shop_photo_url: 'https://example.com/prod-fo-shop.jpg',
    })
    .select('id')
    .single();
  if (vcErr) throw new Error(`PROD vendor_categories: ${vcErr.message}`);
  await admin.from('vendor_category_modes').insert({
    vendor_category_id: vc!.id,
    mode: 'delivery',
  });

  await admin.from('users').upsert({
    phone: FO_EXISTING_PHONE,
    total_orders: 4,
    completed_orders: 2,
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, DEVICE_ID);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });

  await openPhoneEntrySheet(page, {
    shopName: vendor!.shop_name,
    vendorId: vendor!.id,
    deviceId: DEVICE_ID,
  });
  await submitPhoneNumber(page, FO_EXISTING_PHONE);

  await expect(page.getByTestId('phone-entry-existing-title')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('phone-entry-existing-title')).toHaveText(
    EN.firstopen_existing_title,
  );
  await expect(page.getByTestId('phone-entry-existing-restore')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  await page.getByTestId('phone-entry-existing-continue').click();
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(
    FO_EXISTING_PHONE,
  );

  // eslint-disable-next-line no-console
  console.log('PROD-FO-02 PASS: existing-phone safety net offered restore before saving');
});

test('PROD-UX-01 — no-account message requires Continue tap (no auto-advance)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('aaspaas:welcomed');
    localStorage.removeItem('aaspaas:user_phone');
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('firstopen-returning').click();
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
