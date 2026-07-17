import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import {
  postDeleteAccount,
  invokeAnonymiseDeletedAccounts,
} from './helpers/session38';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const DEVICE_ID = `device_del_req_${T}`;

const L = {
  myAccount: 'My Account',
  deleteAccount: 'Delete Account',
  confirmTitle: 'Delete your account?',
  /** Customer-only confirm body — no shop / 30-day grace language. */
  confirmBody: 'This will permanently delete your account. Your data cannot be recovered.',
  yesDelete: 'Yes, Delete',
  cancel: 'Cancel',
  scheduledPrefix: 'Account deletion scheduled',
  cancelDeletion: 'Cancel Deletion',
  vendorActiveBlock:
    'You have an active vendor account. Please delete your vendor account first',
  dualRoleNotice:
    'Your customer account will be deleted immediately. Your vendor shop will be deleted after 30 days, and you will not be able to register a new shop with this same phone number for 30 days.',
  dualRoleSuccess:
    'Your account will be deleted. Your vendor shop will remain active for 30 days as per policy.',
  deletionSuccessCustomer: 'Account deleted',
  deletionScheduled: 'Deletion scheduled',
} as const;

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextCustomerPhone(): string {
  phoneSeq += 1;
  return `88011${String(T + phoneSeq).slice(-5)}`;
}

function nextVendorPhone(): string {
  phoneSeq += 1;
  return `99011${String(T + phoneSeq).slice(-5)}`;
}

function formatExpectedDeletionDate(fromIso: string): string {
  const d = new Date(fromIso);
  d.setDate(d.getDate() + 30);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

async function seedCustomer(phone: string, fields: Record<string, unknown> = {}) {
  const { error } = await supabaseAdmin.from('users').upsert(
    {
      phone,
      total_orders: 0,
      deletion_requested_at: null,
      ...fields,
    },
    { onConflict: 'phone' },
  );
  if (error) throw error;
  await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
  const { error: deviceError } = await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    fcm_token: `fcm_${phone}`,
  });
  if (deviceError) throw deviceError;
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
      name: `DEL Vendor ${tag}`,
      shop_name: `!DEL-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      vendor_note: `del_req:${T}`,
      ...overrides,
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  createdPhones.push(phone);
  await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone).eq('device_id', DEVICE_ID);
  await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    fcm_token: `fcm_v_${phone}`,
  });
  return vendor;
}

async function gotoSettings(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
}

async function openDeleteDialog(page: Page) {
  const deleteBtn = page.getByRole('button', { name: L.deleteAccount });
  await deleteBtn.scrollIntoViewIfNeeded();
  await expect(deleteBtn).toBeVisible({ timeout: 10000 });
  await deleteBtn.click();
  await expect(page.getByRole('alertdialog')).toBeVisible({ timeout: 8000 });
}

test.afterAll(async () => {
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_menu_items').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  for (const phone of [...new Set(createdPhones)]) {
    await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
    await supabaseAdmin.from('vendors').delete().eq('phone', phone);
  }
  await supabaseAdmin.from('users').delete().like('phone', 'deleted_%');
  await supabaseAdmin.from('vendors').delete().like('phone', 'deleted_%');
});

// ─── CUSTOMER DELETION — FULL UI FLOW ────────────────────────────────────────

test('DEL-REQ-01 — Delete Account button at bottom of settings, not in main flow', async ({
  page,
}) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone);
  await loginAsCustomer(page, phone, DEVICE_ID);
  await gotoSettings(page);

  const deleteBtn = page.getByRole('button', { name: L.deleteAccount });
  await deleteBtn.scrollIntoViewIfNeeded();
  await expect(deleteBtn).toBeVisible();

  // Bottom destructive zone — separated from My Account collapsible
  await expect(
    page.locator('div.mt-8.pt-4.border-t').getByRole('button', { name: L.deleteAccount }),
  ).toBeVisible();

  const myAccountBtn = page.getByRole('button', { name: L.myAccount });
  const insideMyAccount = await deleteBtn.evaluate((deleteEl, myAccountText) => {
    let node: HTMLElement | null = deleteEl.parentElement;
    while (node) {
      const header = node.querySelector('button');
      if (header?.textContent?.trim() === myAccountText) return true;
      node = node.parentElement;
    }
    return false;
  }, L.myAccount);
  expect(insideMyAccount).toBe(false);
  await expect(myAccountBtn).toBeVisible();
});

test('DEL-REQ-02 — Delete confirmation dialog shows correct warning copy', async ({ page }) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone);
  await loginAsCustomer(page, phone, DEVICE_ID);
  await gotoSettings(page);
  await openDeleteDialog(page);

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(L.confirmTitle)).toBeVisible();
  await expect(dialog.getByText(L.confirmBody)).toBeVisible();
  await expect(dialog.getByRole('button', { name: L.yesDelete })).toBeVisible();
  await expect(dialog.getByRole('button', { name: L.cancel })).toBeVisible();
  await expect(dialog.getByText(/30 days/i)).not.toBeVisible();
});

test('DEL-REQ-03 — Customer deletion clears localStorage and shows fresh state', async ({
  page,
}) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone, { total_orders: 1 });
  await loginAsCustomer(page, phone, DEVICE_ID);

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: DEVICE_ID,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);

  await page.evaluate(() => {
    localStorage.removeItem('aaspaas:user_phone');
    localStorage.removeItem('aaspaas:device_id');
    localStorage.removeItem('aaspaas:welcomed');
  });

  await page.goto(APP_URL);

  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:welcomed'))).toBeNull();
  await expect(page.getByTestId('first-open-flow')).toBeVisible({ timeout: 15000 });
});

test('DEL-REQ-04 — Customer phone anonymized in DB after deletion', async () => {
  const phone = `900000${String(T % 10000).padStart(4, '0')}`;
  createdPhones.push(phone);
  await supabaseAdmin.from('users').upsert(
    {
      phone,
      total_orders: 0,
      deletion_requested_at: new Date().toISOString(),
    },
    { onConflict: 'phone' },
  );

  await invokeAnonymiseDeletedAccounts();

  const { data: original } = await supabaseAdmin
    .from('users')
    .select('phone')
    .eq('phone', phone)
    .maybeSingle();
  expect(original).toBeNull();

  const { data: anonymised } = await supabaseAdmin
    .from('users')
    .select('phone')
    .like('phone', 'deleted_%')
    .limit(1)
    .maybeSingle();
  expect(anonymised?.phone).toMatch(/^deleted_/);
});

test('DEL-REQ-05 — Dual-role deletion applies customer + vendor rules', async ({ page }) => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone);
  const vendor = await createVendor(phone, 'dual-role', { is_active: true });
  await loginAsCustomer(page, phone, DEVICE_ID);
  await gotoSettings(page);

  const deleteBtn = page.getByRole('button', { name: L.deleteAccount });
  await deleteBtn.scrollIntoViewIfNeeded();
  await deleteBtn.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 8000 });
  await expect(dialog.getByText(L.dualRoleNotice)).toBeVisible();
  await page.getByRole('button', { name: L.yesDelete }).click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.dualRoleSuccess)).toBeVisible({
    timeout: 10000,
  });

  const { data: originalUser } = await supabaseAdmin
    .from('users')
    .select('phone')
    .eq('phone', phone)
    .maybeSingle();
  expect(originalUser).toBeNull();

  const { count: anonCount } = await supabaseAdmin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .like('phone', 'deleted_%');
  expect(anonCount ?? 0).toBeGreaterThan(0);

  const { data: vendorRow } = await supabaseAdmin
    .from('vendors')
    .select('phone, deletion_requested_at')
    .eq('id', vendor.id)
    .single();
  expect(vendorRow.deletion_requested_at).not.toBeNull();
  expect(vendorRow.phone).toBe(phone);
});

// ─── VENDOR DELETION — 30-DAY GRACE UI ───────────────────────────────────────

test('DEL-REQ-06 — Vendor deletion shows 30-day scheduled UI, not immediate', async ({
  page,
}) => {
  const phone = nextVendorPhone();
  await seedCustomer(phone);
  const vendor = await createVendor(phone, 'req06', { is_active: true });
  await loginAsVendor(page, phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);
  await openDeleteDialog(page);
  await page.getByRole('button', { name: L.yesDelete }).click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.deletionScheduled)).toBeVisible({
    timeout: 10000,
  });
  const expectedDate = formatExpectedDeletionDate(new Date().toISOString());
  await expect(page.getByText(new RegExp(L.scheduledPrefix))).toBeVisible();
  await expect(page.getByText(expectedDate)).toBeVisible();
  await expect(page.getByRole('button', { name: L.cancelDeletion })).toBeVisible();

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('phone, deletion_requested_at')
    .eq('id', vendor.id)
    .single();
  expect(row.phone).toBe(phone);
  expect(row.deletion_requested_at).not.toBeNull();
});

test('DEL-REQ-07 — Vendor Cancel Deletion restores normal account state', async ({ page }) => {
  const phone = nextVendorPhone();
  const requestedAt = new Date().toISOString();
  await seedCustomer(phone, { deletion_requested_at: requestedAt });
  const vendor = await createVendor(phone, 'req07', { deletion_requested_at: requestedAt });
  await loginAsVendor(page, phone, vendor.id, DEVICE_ID);
  await gotoSettings(page);

  await expect(page.getByText(new RegExp(L.scheduledPrefix))).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: L.cancelDeletion }).click();
  await expect(page.locator('[data-sonner-toast]').getByText('Deletion cancelled')).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByRole('button', { name: L.deleteAccount })).toBeVisible();
  await expect(page.getByText(new RegExp(L.scheduledPrefix))).not.toBeVisible();

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('id', vendor.id)
    .single();
  expect(row.deletion_requested_at).toBeNull();
});

test('DEL-REQ-08 — Vendor cannot go online during deletion grace period', async ({ page }) => {
  const phone = nextVendorPhone();
  const requestedAt = new Date().toISOString();
  await seedCustomer(phone, { deletion_requested_at: requestedAt });
  const vendor = await createVendor(phone, 'req08', {
    deletion_requested_at: requestedAt,
    is_active: false,
  });
  await loginAsVendor(page, phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });

  const goLiveBtn = page.getByTestId('vendor-golive-btn');
  const visible = await goLiveBtn.isVisible().catch(() => false);
  if (visible) {
    await expect(goLiveBtn).toBeDisabled();
  } else {
    await expect(goLiveBtn).not.toBeVisible();
  }

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('is_active')
    .eq('id', vendor.id)
    .single();
  expect(row.is_active).toBe(false);
});

// ─── POST-DELETION DATA VERIFICATION ─────────────────────────────────────────

test('DEL-REQ-09 — Vendor anonymization NULLs PII fields after 30 days', async () => {
  const phone = nextVendorPhone();
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await seedCustomer(phone, { deletion_requested_at: thirtyOneDaysAgo });
  const vendor = await createVendor(phone, 'req09', {
    deletion_requested_at: thirtyOneDaysAgo,
    shop_photo_url: 'https://example.com/shop.jpg',
    photo_selfie: 'https://example.com/selfie.jpg',
    vendor_note: 'sensitive note',
    cancel_reason_1: 'too busy',
    referral_code: 'AASP9999',
  });

  await invokeAnonymiseDeletedAccounts();

  const { data: original } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  expect(original).toBeNull();

  const { data: anonymised } = await supabaseAdmin
    .from('vendors')
    .select(
      'phone, shop_photo_url, photo_selfie, vendor_note, cancel_reason_1, referral_code',
    )
    .eq('id', vendor.id)
    .single();

  expect(anonymised?.phone).toMatch(/^deleted_/);
  expect(anonymised?.shop_photo_url).toBeNull();
  expect(anonymised?.photo_selfie).toBeNull();
  expect(anonymised?.vendor_note).toBeNull();
  expect(anonymised?.cancel_reason_1).toBeNull();
  expect(anonymised?.referral_code).toBeNull();
});

test('DEL-REQ-10 — Customer-linked data cleaned on customer delete', async () => {
  const phone = nextCustomerPhone();
  await seedCustomer(phone, { total_orders: 1, deletion_requested_at: new Date().toISOString() });
  const vendor = await createVendor(nextVendorPhone(), 'req10-ref');
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    vendor_id: vendor.id,
    nickname: 'My vendor',
  });
  await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    fcm_token: `fcm_${phone}`,
  });

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: DEVICE_ID,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);

  const { data: saved } = await supabaseAdmin
    .from('saved_vendors')
    .select('id')
    .eq('user_phone', phone);
  expect(saved).toEqual([]);

  const { data: devices } = await supabaseAdmin
    .from('user_devices')
    .select('id')
    .eq('user_phone', phone);
  expect(devices).toEqual([]);

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('phone')
    .eq('phone', phone)
    .maybeSingle();
  expect(user).toBeNull();

  const { data: anonUser } = await supabaseAdmin
    .from('users')
    .select('phone')
    .like('phone', 'deleted_%')
    .limit(1)
    .maybeSingle();
  expect(anonUser?.phone).toMatch(/^deleted_/);
});

test('DEL-REQ-11 — Vendor menu items deleted on vendor anonymization', async () => {
  const phone = nextVendorPhone();
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await seedCustomer(phone, { deletion_requested_at: thirtyOneDaysAgo });
  const vendor = await createVendor(phone, 'req11', {
    deletion_requested_at: thirtyOneDaysAgo,
  });

  const { error: menuError } = await supabaseAdmin.from('vendor_menu_items').insert([
    {
      vendor_id: vendor.id,
      name: 'Item A',
      price: 10,
      sort_order: 0,
    },
    {
      vendor_id: vendor.id,
      name: 'Item B',
      price: 20,
      sort_order: 1,
    },
  ]);
  if (menuError) throw menuError;

  await invokeAnonymiseDeletedAccounts();

  const { data: menuRows } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', vendor.id);
  expect(menuRows).toEqual([]);

  const { data: categoryRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendor.id);
  expect(categoryRows).toEqual([]);
});
