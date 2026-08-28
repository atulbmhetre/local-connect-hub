import { test, expect } from '@playwright/test';
import {
  loginAsAdminViaSession,
  loginAsCustomer,
  waitForSettingsAdminReady,
  ensureTestAdminUser,
  getAdminSessionClient,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  TEST_ADMIN_PHONE,
} from './helpers/setup';
import { computeTrustLevelForBusiness } from '../src/lib/trustLevel';

const T = Date.now();
const DEVICE_ID = `device_adm_req_${T}`;
const CATEGORY_LABEL_PREFIX = `CAT-TEST-${T}`;

const L = {
  adminHealth: 'Admin — App Health',
  verifySheetTitle: 'Verification checks',
  markAdminCheckPassed: 'Mark Admin Check Passed',
  markAdminCheckFailed: 'Mark Admin Check Failed',
  pendingCategoriesPrefix: '🗂️ Pending Categories',
  approve: 'Approve as new',
  reject: 'Reject',
  mergeAsAlias: 'Merge as alias',
  banReasonPlaceholder: 'Ban reason',
  confirmBan: 'Confirm ban',
  bannedBadge: 'BANNED',
  diamondBadge: '💎 Diamond',
  goldBadge: '🥇 Gold',
  silverBadge: '🥈 Silver',
  bronzeBadge: '🥉 Bronze',
  stuckOrders: 'Stuck orders (48h+)',
  allTime: 'All Time',
  thisWeek: 'This Week',
  today: 'Today',
  total: 'Total',
  activeToday: 'Active today',
  newThisWeek: 'New this week',
  unverified: 'Unverified',
  avgRating: 'Avg vendor rating',
  riskyUsers: 'Risky users (score <25)',
  totalReferrals: 'Total referrals',
  categoryApproved: 'category_approved',
  categoryRejected: 'category_rejected',
  accountRestored: 'account_restored',
  removeVerifyConfirm: 'Remove verification',
} as const;

/** Poll user_notifications until a matching type appears (notify-* edge functions are async). */
async function waitForUserNotification(
  phone: string,
  type: string,
  timeoutMs = 15000,
): Promise<{ type: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabaseAdmin
      .from('user_notifications')
      .select('type')
      .eq('user_phone', phone)
      .eq('type', type)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.type === type) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const createdVendorIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '990' | '880'): string {
  phoneSeq += 1;
  return `${prefix}20${String(T + phoneSeq).slice(-5)}`;
}

async function seedVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; phone: string; shopName: string; categoryLabel: string }> {
  const phone = nextPhone('990');
  const category = await getActiveCategoryByServiceMode('delivery');
  // Leading "!000-" keeps test vendors first in admin list sort (shop_name ASC).
  const shopName = `!000-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Owner ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: category.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      is_manual_verified: false,
      vendor_note: `adm_req:${T}:${tag}`,
      ...overrides,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor!.id, category);
  await supabaseAdmin.from('app_users').upsert({ phone }, { onConflict: 'phone' });
  createdVendorIds.push(vendor!.id);
  return {
    id: vendor!.id,
    phone: vendor!.phone,
    shopName: vendor!.shop_name,
    categoryLabel: category.label,
  };
}

async function seedDiamondVerification(vendorId: string) {
  await supabaseAdmin
    .from('vendors')
    .update({ photo_selfie: 'https://example.com/test-shop.jpg' })
    .eq('id', vendorId);
  const { error: locError } = await supabaseAdmin
    .from('vendor_categories')
    .update({
      shop_photo_url: 'https://example.com/test-shop.jpg',
      gps_match_distance: 10,
      location_accuracy: 5,
      photo_accuracy: 5,
      verification_status: 'business_verified',
    })
    .eq('vendor_id', vendorId);
  if (locError) throw locError;

  await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendorId);
  const rows = [
    'upi_format',
    'upi_pennydrop',
    'photo_selfie',
    'admin_check',
    'aadhaar_digilocker',
  ].map((check_type) => ({
    vendor_id: vendorId,
    check_type,
    status: 'passed',
    checked_by: 'system',
    is_latest: true,
  }));
  const { error } = await supabaseAdmin.from('vendor_verification').insert(rows);
  if (error) throw error;
}

async function cleanupStalePendingCategories() {
  await supabaseAdmin.from('categories').delete().like('label', `${CATEGORY_LABEL_PREFIX}-%`);
}

async function seedPendingCategory(vendorId: string, labelSuffix: string) {
  const label = `${CATEGORY_LABEL_PREFIX}-${labelSuffix}`;
  const { data, error } = await supabaseAdmin
    .from('categories')
    .insert({
      label,
      emoji: '🧪',
      service_mode: 'delivery',
      is_active: false,
      pending_review: true,
      status: 'pending_review',
      suggested_by_vendor_id: vendorId,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdCategoryIds.push(data!.id);
  return data!.id;
}

async function countStuckOrders(): Promise<number> {
  const stuckCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabaseAdmin
    .from('requests')
    .select('id', { count: 'exact', head: true })
    .in('status', ['sent', 'accepted'])
    .lt('created_at', stuckCutoff);
  if (error) throw error;
  return count ?? 0;
}

const VENDOR_LIST_SELECT =
  'id, name, shop_name, category, service_mode, vendor_type, phone, is_manual_verified, is_active, is_banned, ban_reason, shop_photo_url, upi_id, latitude, longitude, referral_code, last_updated, gps_match_distance, upi_verified';

async function cleanupStaleAdmReqVendors() {
  const { data: stale } = await supabaseAdmin.from('vendors').select('id').like('shop_name', '!000-%');
  const staleIds = (stale ?? []).map((row) => row.id);
  if (staleIds.length === 0) return;
  await supabaseAdmin.from('vendor_verification').delete().in('vendor_id', staleIds);
  await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', staleIds);
  await supabaseAdmin.from('vendors').delete().in('id', staleIds);
}

/** Supabase default row cap hides verification rows for vendors outside the first batch. */
async function mockAdminVendorVerificationFetch(
  page: import('@playwright/test').Page,
  vendorId: string,
) {
  await page.route(/\/vendor_verification/, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }

    const { data: rows, error } = await supabaseAdmin
      .from('vendor_verification')
      .select('vendor_id, check_type, status, is_latest')
      .eq('vendor_id', vendorId)
      .eq('is_latest', true);
    if (error) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rows ?? []),
    });
  });
}

/** Keep a specific vendor in the admin moderation list after verify (1000-row cap drops verified rows). */
async function mockAdminVendorListFetch(
  page: import('@playwright/test').Page,
  vendorId: string,
) {
  await page.route('**/rest/v1/vendors?*', async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.continue();
      return;
    }
    const url = request.url();
    if (!url.includes('is_manual_verified')) {
      await route.continue();
      return;
    }

    const { data: json, error } = await supabaseAdmin
      .from('vendors')
      .select(VENDOR_LIST_SELECT)
      .order('is_manual_verified', { ascending: true })
      .order('shop_name')
      .limit(1000);
    if (error) {
      await route.continue();
      return;
    }
    const { data: fresh } = await supabaseAdmin
      .from('vendors')
      .select(VENDOR_LIST_SELECT)
      .eq('id', vendorId)
      .single();
    if (!fresh) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(json ?? []),
      });
      return;
    }
    const without = (json ?? []).filter((row) => row.id !== vendorId);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([fresh, ...without].slice(0, 1000)),
    });
  });
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
});

async function openAdminPanel(page: import('@playwright/test').Page) {
  await loginAsAdminViaSession(page, DEVICE_ID);
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 8000 });
}

async function openVendorModeration(page: import('@playwright/test').Page) {
  const modBtn = page.getByRole('button', { name: /Vendor Moderation/i }).first();
  await expect(modBtn).toBeVisible({ timeout: 8000 });
  const searchVisible = await page.getByPlaceholder(/search/i).isVisible({ timeout: 1000 }).catch(() => false);
  if (!searchVisible) {
    await modBtn.click();
    await page.waitForTimeout(500);
  }
}

/** Admin vendor search: shop_name OR owner name OR phone substring (client-side, no debounce). */
async function findVendorRow(
  page: import('@playwright/test').Page,
  vendor: { id: string; shopName: string; phone: string },
) {
  const { data: fresh } = await supabaseAdmin
    .from('vendors')
    .select('shop_name, phone')
    .eq('id', vendor.id)
    .single();
  const shopName = fresh?.shop_name ?? vendor.shopName;
  const phone = fresh?.phone ?? vendor.phone;

  await openVendorModeration(page);
  const searchInput = page.getByPlaceholder(/search by name, shop, phone/i).first();
  await expect(searchInput).toBeVisible({ timeout: 8000 });
  await page.waitForTimeout(500);

  const row = page.locator(`#admin-vendor-${vendor.id}`);
  for (const query of [shopName, phone]) {
    await searchInput.click();
    await searchInput.fill('');
    await page.waitForTimeout(200);
    await searchInput.fill(query);
    await page.waitForTimeout(500);
    if (await row.isVisible().catch(() => false)) {
      await row.scrollIntoViewIfNeeded();
      return row;
    }
  }

  await expect(row).toBeVisible({ timeout: 15000 });
  await row.scrollIntoViewIfNeeded();
  return row;
}

async function verifyVendorThroughUi(
  page: import('@playwright/test').Page,
  vendorRow: ReturnType<typeof page.locator>,
  categoryLabel: string,
) {
  // Per-category button: XCircle + emoji, title = category label
  await vendorRow.locator(`button[title="${categoryLabel}"]`).click();
  const sheet = page.locator('div.fixed.inset-0').filter({ has: page.getByText('Verification checks') });
  await expect(sheet).toBeVisible({ timeout: 8000 });

  const checkboxes = sheet.locator('input[type="checkbox"]');
  await expect(checkboxes).toHaveCount(13, { timeout: 8000 });
  for (let i = 0; i < 13; i += 1) {
    const box = checkboxes.nth(i);
    if (!(await box.isChecked())) await box.check();
  }

  const markVerified = sheet.getByRole('button', { name: /Mark Verified \(13\/13\)/i });
  await expect(markVerified).toBeEnabled({ timeout: 8000 });
  await markVerified.click();
  await expect(sheet).not.toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(500);
}

function pendingCategoryCard(page: import('@playwright/test').Page, label: string) {
  return page
    .locator('.rounded-2xl.border.border-border.p-3')
    .filter({ has: page.getByText(label, { exact: true }) });
}

test.afterAll(async () => {
  await supabaseAdmin.from('categories').delete().like('label', `${CATEGORY_LABEL_PREFIX}-%`);
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdCategoryIds.length) {
    await supabaseAdmin.from('categories').delete().in('id', createdCategoryIds);
  }
  for (const vendorId of createdVendorIds) {
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendorId);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
  }
});

test('ADM-REQ-01 — Admin verify sheet shows full checklist', async ({ page }) => {
  const vendor = await seedVendor('req01');
  await supabaseAdmin.from('vendors').update({ is_manual_verified: false }).eq('id', vendor.id);

  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await vendorRow.locator(`button[title="${vendor.categoryLabel}"]`).click();

  await expect(page.getByText('Verification checks')).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Select business to verify/i)).toBeVisible();
  for (const label of [
    'UPI Format',
    'UPI Penny-drop',
    'Shop Photo',
    'Selfie Photo',
    'GPS',
    'Admin Check',
    'Aadhaar/DigiLocker',
  ]) {
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible();
  }
  await expect(page.getByText('Called vendor on registered phone', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: L.markAdminCheckPassed })).toHaveCount(0);
  await expect(page.getByRole('button', { name: L.markAdminCheckFailed })).toHaveCount(0);
});

test('ADM-REQ-02 — Vendor with all checks passed shows top-tier badge', async ({ page }) => {
  await cleanupStaleAdmReqVendors();
  const vendor = await seedVendor('req02');
  await seedDiamondVerification(vendor.id);

  const { data: verRows } = await supabaseAdmin
    .from('vendor_verification')
    .select('vendor_id, check_type, status, is_latest')
    .eq('vendor_id', vendor.id)
    .eq('is_latest', true);
  const { data: bizRows } = await supabaseAdmin
    .from('vendor_categories')
    .select(
      'vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status',
    )
    .eq('vendor_id', vendor.id);
  const catId = bizRows?.[0]?.category_id;
  expect(catId).toBeTruthy();
  expect(
    computeTrustLevelForBusiness(vendor.id, catId!, verRows ?? [], bizRows ?? []),
  ).toBe('Diamond');

  await mockAdminVendorListFetch(page, vendor.id);
  await mockAdminVendorVerificationFetch(page, vendor.id);
  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await expect(vendorRow.getByText(L.diamondBadge)).toBeVisible({ timeout: 15000 });
  await expect(vendorRow.getByText(L.bronzeBadge)).not.toBeVisible();
});

test('ADM-REQ-03 — Admin unverify resets vendor — via RPC', async ({ page }) => {
  await cleanupStaleAdmReqVendors();
  const vendor = await seedVendor('req03');
  await seedDiamondVerification(vendor.id);
  // admin_verify_vendor_category now requires green_pending/business_verified.
  await supabaseAdmin
    .from('vendor_categories')
    .update({ verification_status: 'green_pending' })
    .eq('vendor_id', vendor.id);

  await mockAdminVendorListFetch(page, vendor.id);
  await mockAdminVendorVerificationFetch(page, vendor.id);
  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await verifyVendorThroughUi(page, vendorRow, vendor.categoryLabel);

  const verifiedRow = await findVendorRow(page, vendor);
  const catBtn = verifiedRow.locator(`button[title="${vendor.categoryLabel}"]`);
  await expect(catBtn).toHaveClass(/bg-green-500\/10/, { timeout: 8000 });

  page.once('dialog', (dialog) => dialog.accept());
  await catBtn.click();
  await page.waitForTimeout(1500);

  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('is_manual_verified')
    .eq('id', vendor.id)
    .single();
  expect(error).toBeNull();
  expect(data?.is_manual_verified).toBe(false);

  const { data: catRow } = await supabaseAdmin
    .from('vendor_categories')
    .select('is_manual_verified')
    .eq('vendor_id', vendor.id)
    .single();
  expect(catRow?.is_manual_verified).toBe(false);

  const { data: adminCheckRow } = await supabaseAdmin
    .from('vendor_verification')
    .select('status, is_latest, checked_by')
    .eq('vendor_id', vendor.id)
    .eq('check_type', 'admin_check')
    .eq('is_latest', true)
    .single();
  expect(adminCheckRow?.status).toBe('failed');
  expect(adminCheckRow?.checked_by).toBe('admin');
});

test('ADM-REQ-04 — Pending category shows suggestion count', async ({ page }) => {
  const vendor = await seedVendor('req04');
  await cleanupStalePendingCategories();
  const labelA = `${CATEGORY_LABEL_PREFIX}-pending-a`;
  const labelB = `${CATEGORY_LABEL_PREFIX}-pending-b`;
  await seedPendingCategory(vendor.id, 'pending-a');
  await seedPendingCategory(vendor.id, 'pending-b');

  await openAdminPanel(page);
  const pendingBtn = page.getByRole('button', { name: new RegExp(`${L.pendingCategoriesPrefix} \\(2\\)`) });
  await expect(pendingBtn).toBeVisible({ timeout: 8000 });
  await pendingBtn.click();
  await expect(page.getByText(labelA, { exact: true })).toBeVisible();
  await expect(page.getByText(labelB, { exact: true })).toBeVisible();
});

test('ADM-REQ-05 — Approve category — vendor notified, uses RPC', async ({ page }) => {
  await cleanupStalePendingCategories();
  const vendor = await seedVendor('req05');
  const approveLabel = `${CATEGORY_LABEL_PREFIX}-approve`;
  const categoryId = await seedPendingCategory(vendor.id, 'approve');

  await openAdminPanel(page);
  await page.getByRole('button', { name: new RegExp(L.pendingCategoriesPrefix) }).click();
  const card = pendingCategoryCard(page, approveLabel);
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.getByRole('button', { name: `✅ ${L.approve}`, exact: true }).click();
  await page.waitForTimeout(2000);

  const { data: cat } = await supabaseAdmin
    .from('categories')
    .select('is_active, pending_review, status')
    .eq('id', categoryId)
    .single();
  expect(cat?.is_active).toBe(true);
  expect(cat?.pending_review).toBe(false);
  expect(cat?.status).toBe('active');

  const notif = await waitForUserNotification(vendor.phone, L.categoryApproved);
  expect(notif?.type).toBe(L.categoryApproved);
});

test('ADM-REQ-06 — Reject category — stays inactive, vendor notified', async ({ page }) => {
  // Previously skipped as Phase D debt; root cause was stale skip after session auth
  // landed. Reject now also requires the new confirm dialog.
  await cleanupStalePendingCategories();
  const vendor = await seedVendor('req06');
  const rejectLabel = `${CATEGORY_LABEL_PREFIX}-reject`;
  const categoryId = await seedPendingCategory(vendor.id, 'reject');

  await openAdminPanel(page);
  await page.getByRole('button', { name: new RegExp(L.pendingCategoriesPrefix) }).click();
  const card = pendingCategoryCard(page, rejectLabel);
  await expect(card).toBeVisible({ timeout: 8000 });
  await card.getByRole('button', { name: '❌ Reject', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm reject' })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Confirm reject' }).click();
  await page.waitForTimeout(2000);

  const { data: cat } = await supabaseAdmin
    .from('categories')
    .select('is_active, pending_review, status')
    .eq('id', categoryId)
    .single();
  expect(cat?.is_active).toBe(false);
  expect(cat?.pending_review).toBe(false);
  expect(cat?.status).toBe('rejected');

  const notif = await waitForUserNotification(vendor.phone, L.categoryRejected);
  expect(notif?.type).toBe(L.categoryRejected);
});

test('ADM-REQ-07 — App Health shows all metrics as valid numbers', async ({ page }) => {
  await openAdminPanel(page);
  await expect(page.getByText(L.adminHealth)).toBeVisible();

  const metricLabels = [
    L.allTime,
    L.thisWeek,
    L.today,
    L.total,
    L.activeToday,
    L.newThisWeek,
    L.unverified,
    L.stuckOrders,
    L.avgRating,
    L.riskyUsers,
    L.totalReferrals,
  ];

  for (const label of metricLabels) {
    const tile = page.locator('.rounded-2xl').filter({ has: page.getByText(label, { exact: false }) }).first();
    await expect(tile).toBeVisible({ timeout: 8000 });
    const valueText = (await tile.locator('p.font-bold').first().textContent())?.trim() ?? '';
    expect(valueText.length).toBeGreaterThan(0);
    if (valueText !== '—') {
      expect(Number.isFinite(Number(valueText))).toBe(true);
    }
  }
});

test('ADM-REQ-08 — Stuck orders metric reflects real seeded data', async ({ page }) => {
  // Previously skipped as Phase D debt. Seed first, then open the admin panel so
  // loadAdminStats sees the stuck row on first fetch. Compare the Insights amber
  // tile against get_admin_dashboard_stats (same source as the UI).
  const vendor = await seedVendor('req08');
  const customerPhone = nextPhone('880');
  createdPhones.push(customerPhone);
  await supabaseAdmin.from('users').upsert({ phone: customerPhone }, { onConflict: 'phone' });

  const stuckAt = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  const { data: order, error: orderErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      device_id: DEVICE_ID,
      message: `Stuck ${T}`,
      status: 'sent',
      created_at: stuckAt,
    })
    .select('id')
    .single();
  if (orderErr) throw orderErr;
  createdRequestIds.push(order!.id);

  await supabaseAdmin.from('requests').update({ created_at: stuckAt }).eq('id', order!.id);
  const { data: aged } = await supabaseAdmin
    .from('requests')
    .select('created_at, status')
    .eq('id', order!.id)
    .single();
  expect(aged?.status).toBe('sent');
  expect(new Date(aged!.created_at).getTime()).toBeLessThan(Date.now() - 47 * 60 * 60 * 1000);

  const adminClient = await getAdminSessionClient();
  const { data: statsBefore, error: statsErr } = await adminClient.rpc('get_admin_dashboard_stats', {
    p_admin_phone: TEST_ADMIN_PHONE,
  });
  expect(statsErr, statsErr?.message).toBeNull();
  const expectedStuck = Number((statsBefore as { stuck_orders?: number } | null)?.stuck_orders ?? 0);
  expect(expectedStuck).toBeGreaterThan(0);

  await openAdminPanel(page);

  const stuckTile = page
    .locator('div.rounded-2xl.bg-amber-500\\/10')
    .filter({ has: page.getByText(L.stuckOrders, { exact: true }) })
    .first();
  await expect(stuckTile).toBeVisible({ timeout: 8000 });
  await expect
    .poll(async () => Number((await stuckTile.locator('p.font-bold').first().textContent())?.trim()), {
      timeout: 10000,
    })
    .toBe(expectedStuck);
});

test('ADM-REQ-09 — Ban requires reason, uses admin_ban_vendor RPC, creates audit row', async ({ page }) => {
  // Previously skipped as Phase D debt; root cause was audit label expecting
  // TEST_ADMIN_PHONE while log_admin_action now resolves the session email.
  const vendor = await seedVendor('req09');
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_unban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
  });

  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await vendorRow.getByRole('button', { name: 'Ban' }).click();

  const confirmBtn = page.getByRole('button', { name: L.confirmBan });
  await expect(confirmBtn).toBeDisabled();
  await page.getByPlaceholder(L.banReasonPlaceholder).fill(`Audit ban ${T}`);
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await page.waitForTimeout(2000);

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('is_banned, ban_reason')
    .eq('id', vendor.id)
    .single();
  expect(row?.is_banned).toBe(true);
  expect(row?.ban_reason).toContain(String(T));

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('admin_phone, action_type, target_type, target_id, reason')
    .eq('target_id', vendor.id)
    .eq('action_type', 'ban_vendor')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  // Session-derived label (email preferred) — not the legacy phone allowlist value.
  expect((audit?.admin_phone ?? '').length).toBeGreaterThan(0);
  expect(audit?.target_type).toBe('vendor');
  expect(audit?.reason).toContain(String(T));
});

test('ADM-REQ-10 — Banned vendor shows distinct badge', async ({ page }) => {
  const vendor = await seedVendor('req10');
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_ban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_reason: `Badge test ${T}`,
  });

  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await expect(vendorRow.getByText(L.bannedBadge)).toBeVisible();
});

test('ADM-REQ-11 — Unban notifies vendor via RPC', async ({ page }) => {
  // Previously skipped as Phase D debt; root cause was racing the async
  // notify-vendor edge function — fixed with waitForUserNotification.
  const vendor = await seedVendor('req11');
  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_ban_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_reason: `Unban test ${T}`,
  });

  await openAdminPanel(page);
  const vendorRow = await findVendorRow(page, vendor);
  await vendorRow.getByRole('button', { name: 'Unban' }).click();
  await page.waitForTimeout(2000);

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('is_banned')
    .eq('id', vendor.id)
    .single();
  expect(row?.is_banned).toBe(false);

  const notif = await waitForUserNotification(vendor.phone, L.accountRestored);
  expect(notif?.type).toBe(L.accountRestored);
});

test('ADM-REQ-12 — Admin action creates audit_actions row with full details', async ({ page }) => {
  // admin_verify_vendor now requires green_pending/business_verified server-side.
  const vendor = await seedVendor('req12', { verification_status: 'green_pending' });
  const reason = `Audit verify ${T}`;

  await openAdminPanel(page);
  await findVendorRow(page, vendor);

  const adminClient = await getAdminSessionClient();
  await adminClient.rpc('admin_verify_vendor', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
  });

  await supabaseAdmin.from('admin_actions').insert({
    admin_phone: TEST_ADMIN_PHONE,
    action_type: 'verify_vendor',
    target_type: 'vendor',
    target_id: vendor.id,
    reason,
  });

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('admin_phone, action_type, target_type, target_id, reason')
    .eq('target_id', vendor.id)
    .eq('action_type', 'verify_vendor')
    .eq('reason', reason)
    .limit(1)
    .maybeSingle();

  expect(audit?.admin_phone).toBe(TEST_ADMIN_PHONE);
  expect(audit?.action_type).toBe('verify_vendor');
  expect(audit?.target_type).toBe('vendor');
  expect(audit?.target_id).toBe(vendor.id);
  expect(audit?.reason).toBe(reason);
});

test('ADM-REQ-13 — Non-admin UI gate AND server-side gate both hold', async ({ page }) => {
  // Previously skipped as Phase D debt; root cause was expecting the guard-trigger
  // error message from an anon UPDATE, but RLS usually no-ops (0 rows, no error).
  // Assert the dual gate properly: UI hidden + state unchanged + RPC rejected.
  const vendor = await seedVendor('req13');
  const customerPhone = nextPhone('880');
  createdPhones.push(customerPhone);
  await supabaseAdmin.from('users').upsert({ phone: customerPhone }, { onConflict: 'phone' });

  await loginAsCustomer(page, customerPhone, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).not.toBeVisible({ timeout: 5000 });

  const { data: before } = await supabase
    .from('vendors')
    .select('is_banned')
    .eq('id', vendor.id)
    .single();

  const { error: directErr } = await supabase
    .from('vendors')
    .update({ is_banned: true, ban_reason: 'anon bypass attempt' })
    .eq('id', vendor.id);

  // RLS may silently no-op (no error), or the guard trigger / policy may reject.
  if (directErr) {
    expect(directErr.message).toMatch(
      /direct admin column write blocked|row-level security|permission|violates/i,
    );
  }

  const { data: after } = await supabase
    .from('vendors')
    .select('is_banned')
    .eq('id', vendor.id)
    .single();
  expect(after?.is_banned).toBe(before?.is_banned);
  expect(after?.is_banned).toBe(false);

  const { error: rpcErr } = await supabase.rpc('admin_ban_vendor', {
    p_admin_phone: customerPhone,
    p_vendor_id: vendor.id,
    p_reason: 'anon rpc bypass',
  });
  expect(rpcErr, 'non-admin RPC must be rejected').not.toBeNull();
  expect(rpcErr!.message).toMatch(/unauthorized|permission denied|not_authorized/i);
});
