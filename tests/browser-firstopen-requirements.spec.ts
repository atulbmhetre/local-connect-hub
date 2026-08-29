import { test, expect, Page } from '@playwright/test';
import {
  loginAsFreshUser,
  completeOtpIfVisible,
  prepareUiOtpSend,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { strings } from '../src/lib/strings';

test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ timeout: 180_000 });

const T = Date.now();
const DEVICE_ID = `device_fo_req_${T}`;
const EN = strings.en;

const createdPhones: string[] = [];
const createdVendorIds: string[] = [];
let phoneSeq = 0;
let originalAdminPhone: string | null = null;

function nextCustomerPhone(): string {
  phoneSeq += 1;
  return `88020${String(T + phoneSeq).slice(-5)}`;
}

function nextVendorPhone(): string {
  phoneSeq += 1;
  return `99020${String(T + phoneSeq).slice(-5)}`;
}

async function seedCustomer(phone: string, fields: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin.from('users').upsert(
    {
      phone,
      total_orders: 1,
      trust_score: 75,
      ...fields,
    },
    { onConflict: 'phone' },
  );
  if (error) throw error;
  createdPhones.push(phone);
}

async function createVendor(
  phone: string,
  tag: string,
  overrides: Record<string, unknown> = {},
) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `FO Vendor ${tag}`,
      shop_name: `!FO-${tag}-${T}`,
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
    .select('id, phone')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor!.id, category);
  createdVendorIds.push(vendor!.id);
  createdPhones.push(phone);
  return vendor!;
}

async function snapshotAdminPhone() {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_phone')
    .maybeSingle();
  originalAdminPhone = data?.value ?? null;
}

async function setAdminPhone(phone: string) {
  const { error } = await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'admin_phone', value: phone }, { onConflict: 'key' });
  if (error) throw error;
}

async function restoreAdminPhone() {
  if (originalAdminPhone !== null) {
    await setAdminPhone(originalAdminPhone);
  }
}

async function lsGet(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

async function openRestoreFlow(page: Page) {
  await page.getByTestId('firstopen-returning').click();
  await expect(page.getByTestId('firstopen-restore-cta')).toBeVisible({ timeout: 8000 });
}

async function enterPhone(page: Page, phone: string) {
  await page.getByPlaceholder('98765 43210').pressSequentially(phone, { delay: 50 });
  await page.getByPlaceholder('98765 43210').press('Tab');
}

async function tapRestore(page: Page) {
  await page.getByTestId('firstopen-restore-cta').click();
}

/**
 * Complete FirstOpen: restore skip (pre-SMS) or OTP verify when required.
 */
async function waitForFlowComplete(page: Page, opts?: { otpPhone?: string }) {
  const flow = page.getByTestId('first-open-flow');
  const restoreSkip = page.getByTestId('restore-skip-verify-btn');
  const otpInput = page.getByTestId('otp-input');

  const next = await Promise.race([
    restoreSkip.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'skip' as const),
    otpInput.waitFor({ state: 'visible', timeout: 15000 }).then(() => 'otp' as const),
    flow.waitFor({ state: 'hidden', timeout: 15000 }).then(() => 'done' as const),
  ]).catch(() => 'none' as const);

  if (next === 'skip') {
    await restoreSkip.click();
  } else if (next === 'otp' || (next === 'none' && opts?.otpPhone)) {
    if (!opts?.otpPhone) {
      throw new Error('OTP screen shown but no otpPhone provided to waitForFlowComplete');
    }
    await completeOtpIfVisible(page, opts.otpPhone);
  }

  await Promise.race([
    flow.waitFor({ state: 'hidden', timeout: 25000 }),
    page.getByTestId('home-screen').waitFor({ state: 'visible', timeout: 25000 }),
    page.waitForURL(/\/vendor/, { timeout: 25000 }),
  ]);

  const notifSkip = page.getByTestId('firstopen-notif-skip');
  if (await notifSkip.isVisible().catch(() => false)) {
    await notifSkip.click();
  }

  await expect(flow).not.toBeVisible({ timeout: 15000 });
  if (!/\/vendor/.test(page.url())) {
    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  }
}

async function skipFirstOpenFlow(page: Page) {
  const phone = nextCustomerPhone();
  createdPhones.push(phone);
  await page.getByTestId('firstopen-im-new').click();
  await page.getByTestId('firstopen-use-as-customer').click();
  await page.getByTestId('firstopen-register-phone-input').fill(phone);
  await prepareUiOtpSend('FO-register');
  await page.getByTestId('firstopen-register-phone-continue').click();
  await waitForFlowComplete(page, { otpPhone: phone });
}

test.beforeAll(async () => {
  await snapshotAdminPhone();
});

test.afterAll(async () => {
  await restoreAdminPhone();
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', [...new Set(createdPhones)]);
  }
});

// ─── RESTORE — CUSTOMER ──────────────────────────────────────────────────────

test('FO-REQ-01 — Pure customer restore — phone found in users table', async ({ page }) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone, { total_orders: 3 });

  await loginAsFreshUser(page);
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 8000 });
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
});

test('FO-REQ-02 — No account found — starts fresh', async ({ page }) => {
  const phone = nextCustomerPhone();

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await expect(page.getByTestId('firstopen-restore-cta')).toBeVisible({ timeout: 10000 });
  await tapRestore(page);

  await expect(page.getByTestId('firstopen-restore-message')).toContainText(
    EN.firstopen_no_account,
    { timeout: 10000 },
  );
  await expect(page.getByTestId('firstopen-no-account-continue')).toBeVisible();

  // Former auto-advance was 800ms — stay put well past that without a tap.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('first-open-flow')).toBeVisible();
  await expect(page.getByTestId('firstopen-restore-message')).toBeVisible();
  await expect(page.getByTestId('firstopen-no-account-continue')).toBeVisible();
  expect(await lsGet(page, 'aaspaas:welcomed')).toBeNull();
  expect(await lsGet(page, 'aaspaas:user_phone')).toBeNull();

  createdPhones.push(phone);
  await page.getByTestId('firstopen-no-account-continue').click();
  await waitForFlowComplete(page, { otpPhone: phone });
  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
});

test('FO-REQ-02b — Banned customer restore is blocked (no phone saved)', async ({ page }) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone, { is_banned: true, total_orders: 4, trust_score: 5 });

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByTestId('firstopen-restore-message')).toContainText(
    EN.customer_account_banned,
    { timeout: 15000 },
  );
  expect(await lsGet(page, 'aaspaas:user_phone')).toBeNull();
  await expect(page.getByTestId('first-open-flow')).toBeVisible();
});

// ─── RESTORE — VENDOR ────────────────────────────────────────────────────────

test('FO-REQ-03 — Vendor restore — active vendor fully restored', async ({ page }) => {
  const phone = nextVendorPhone();
  const vendor = await createVendor(phone, 'fo03');

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:vendor_id')).toBe(vendor.id);
  expect(await lsGet(page, 'aaspaas:role')).toBe('vendor');
  await expect(page.getByTestId('nav-vendor')).toBeVisible({ timeout: 8000 });
});

test('FO-REQ-04 — Banned/deleted vendor — customer identity restored, vendor session NOT restored', async ({
  page,
}) => {
  const phone = nextVendorPhone();
  await createVendor(phone, 'fo04', {
    deletion_requested_at: new Date().toISOString(),
    is_active: true,
  });

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:vendor_id')).toBeNull();
  await expect(page.getByTestId('nav-vendor')).not.toBeVisible({ timeout: 3000 });
});

test('FO-REQ-04b — Offline vendor restores session (is_active=false)', async ({ page }) => {
  const phone = nextVendorPhone();
  const vendor = await createVendor(phone, 'fo04b', { is_active: false });

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:vendor_id')).toBe(vendor.id);
  expect(await lsGet(page, 'aaspaas:role')).toBe('vendor');
});

test('FO-REQ-04c — Hidden vendor restores session (discoverable=false)', async ({ page }) => {
  const phone = nextVendorPhone();
  const vendor = await createVendor(phone, 'fo04c', {
    discoverable: false,
    is_active: true,
  });

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:vendor_id')).toBe(vendor.id);
  expect(await lsGet(page, 'aaspaas:role')).toBe('vendor');
});

// ─── RESTORE — DUAL-ROLE & ADMIN ───────────────────────────────────────────

test('FO-REQ-05 — Dual-role restore — both customer and vendor identity from one phone', async ({
  page,
}) => {
  const phone = nextVendorPhone();
  await seedCustomer(phone, { total_orders: 5 });
  const vendor = await createVendor(phone, 'fo05');

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:vendor_id')).toBe(vendor.id);
});

test('FO-REQ-06 — Admin session login — admin panel accessible', async ({ page }) => {
  // Admin access is session-based (admin_users + Auth), not admin_phone restore.
  const phone = nextVendorPhone();
  await createVendor(phone, 'fo06');

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  const { loginAsAdminViaSession } = await import('./helpers/browser-setup');
  await loginAsAdminViaSession(page, `device_fo06_${T}`);
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 10000 });
});

// ─── SKIP PATH ───────────────────────────────────────────────────────────────

test('FO-REQ-07 — New customer path verifies OTP and sets identity', async ({ page }) => {
  await loginAsFreshUser(page);
  await skipFirstOpenFlow(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toMatch(/^88020/);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
  await expect(page.getByTestId('home-screen')).toBeVisible();
});

test('FO-REQ-08 — Vendor registration button navigates correctly', async ({ page }) => {
  const phone = nextVendorPhone();
  createdPhones.push(phone);
  await loginAsFreshUser(page);
  await page.getByTestId('firstopen-im-new').click();
  await expect(page.getByTestId('firstopen-vendor-btn')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('firstopen-vendor-btn').click();
  await page.getByTestId('firstopen-register-phone-input').fill(phone);
  await prepareUiOtpSend('FO-REQ-08');
  await page.getByTestId('firstopen-register-phone-continue').click();
  await waitForFlowComplete(page, { otpPhone: phone });

  await expect(page).toHaveURL(/vendor/, { timeout: 10000 });
  expect(await lsGet(page, 'aaspaas:user_phone')).toBe(phone);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible({ timeout: 5000 });
});

// ─── COMPLETION STATE ────────────────────────────────────────────────────────

test('FO-REQ-09 — Completing flow sets welcomed flag — flow never shows again', async ({
  page,
}) => {
  await loginAsFreshUser(page);
  await skipFirstOpenFlow(page);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
  const welcomedBeforeReload = await lsGet(page, 'aaspaas:welcomed');

  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  expect(welcomedBeforeReload).toBe('true');
});

test('FO-REQ-10 — Phone input validates 10-digit Indian format', async ({ page }) => {
  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, '12345');
  await tapRestore(page);

  await expect(page.getByText(EN.vendor_phone_invalid_body)).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('first-open-flow')).toBeVisible();
  expect(await lsGet(page, 'aaspaas:user_phone')).toBeNull();
});

// ─── TWO-TIER NAV + COPY ─────────────────────────────────────────────────────

test('FO-REQ-11 — Two-tier chooser: new → customer / business; returning → restore', async ({
  page,
}) => {
  await loginAsFreshUser(page);
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 8000 });

  await expect(page.getByTestId('firstopen-im-new')).toHaveText(EN.welcome_im_new);
  await expect(page.getByTestId('firstopen-returning')).toHaveText(EN.welcome_returning);
  await expect(page.getByTestId('firstopen-im-new')).toBeVisible();
  await expect(page.getByTestId('firstopen-use-as-customer')).not.toBeVisible();

  await page.getByTestId('firstopen-im-new').click();
  await expect(page.getByTestId('firstopen-use-as-customer')).toHaveText(
    EN.welcome_use_as_customer,
  );
  await expect(page.getByTestId('firstopen-vendor-btn')).toHaveText(
    EN.welcome_register_business,
  );
  await expect(page.getByTestId('firstopen-new-options-back')).toBeVisible();

  await page.getByTestId('firstopen-new-options-back').click();
  await expect(page.getByTestId('firstopen-im-new')).toBeVisible();

  await page.getByTestId('firstopen-returning').click();
  await expect(page.getByTestId('firstopen-restore-cta')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(EN.firstopen_restore_body)).toBeVisible();
  await expect(page.getByText(/OTP/i)).toHaveCount(0);
  expect(await lsGet(page, 'aaspaas:welcomed')).toBeNull();
});
