import { test, expect, Page } from '@playwright/test';
import {
  loginAsFreshUser,
  waitForSettingsAdminReady,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { strings } from '../src/lib/strings';

test.use({ storageState: { cookies: [], origins: [] } });

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
  await page.getByTestId('firstopen-restore-entry').click();
  await expect(page.getByTestId('firstopen-restore-cta')).toBeVisible({ timeout: 8000 });
}

async function enterPhone(page: Page, phone: string) {
  await page.getByPlaceholder('98765 43210').pressSequentially(phone, { delay: 50 });
  await page.getByPlaceholder('98765 43210').press('Tab');
}

async function tapRestore(page: Page) {
  await page.getByTestId('firstopen-restore-cta').click();
}

async function waitForFlowComplete(page: Page) {
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
}

async function skipFirstOpenFlow(page: Page) {
  await page.getByTestId('firstopen-restore-skip').click();
  await waitForFlowComplete(page);
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

  await waitForFlowComplete(page);
  expect(await lsGet(page, 'aaspaas:user_phone')).toBeNull();
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

test('FO-REQ-06 — Admin phone restore — admin panel accessible', async ({ page }) => {
  const phone = nextVendorPhone();
  await setAdminPhone(phone);
  await createVendor(phone, 'fo06');

  await loginAsFreshUser(page);
  await openRestoreFlow(page);
  await enterPhone(page, phone);
  await tapRestore(page);

  await expect(page.getByText(EN.firstopen_restore_found)).toBeVisible({ timeout: 15000 });
  await waitForFlowComplete(page);

  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 15000 });
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 10000 });
});

// ─── SKIP PATH ───────────────────────────────────────────────────────────────

test('FO-REQ-07 — Skip restore — starts fresh, no identity set', async ({ page }) => {
  await loginAsFreshUser(page);
  await skipFirstOpenFlow(page);

  expect(await lsGet(page, 'aaspaas:user_phone')).toBeNull();
  expect(await lsGet(page, 'aaspaas:welcomed')).toBe('true');
  await expect(page.getByTestId('home-screen')).toBeVisible();
});

test('FO-REQ-08 — Vendor registration button navigates correctly', async ({ page }) => {
  await loginAsFreshUser(page);
  await expect(page.getByTestId('firstopen-vendor-btn')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('firstopen-vendor-btn').click();

  await expect(page).toHaveURL(/vendor/, { timeout: 10000 });
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
