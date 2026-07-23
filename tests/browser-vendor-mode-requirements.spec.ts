import { test, expect, Page } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  ensureVendorGoLivePhotos,
  seedVendorCategory,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const VENDOR_DEVICE_ID = `device_vm_${T}`;

const L = {
  offline: 'Offline',
  onlineReady: 'Ready to Help',
  tapGoOnline: 'Tap to Go Online',
  tapOffline: 'Tap to go offline',
  suspended: 'Account Suspended',
  addLocation: 'Add Location',
  draftTitle: 'Your profile is incomplete',
  draftBody: 'Add your shop location to appear in search results.',
  modeHelp: '🤝 Help',
  modeDelivery: '🚚 Delivery',
  incomingEmpty: 'No orders yet!',
  offlineActiveTitle: 'You have active orders for today',
  stayOnline: 'Stay Online',
  goOfflineAnyway: 'Go Offline Anyway',
  goOfflinePendingTitle: 'Vendor has gone offline',
  notifBellAria: 'Notifications',
  notifBellTitle: 'Notifications',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99002${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88002${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

function todayPlusHoursIso(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function tomorrowAt20Iso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(20, 0, 0, 0);
  return d.toISOString();
}

type VendorRow = {
  id: string;
  phone: string;
  shop_name: string;
  service_mode: string;
};

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `VM Vendor ${tag}`,
      shop_name: `!VM-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: 'complete',
      service_radius_km: 9999,
      vendor_type: 'shop',
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: true,
      ...overrides,
    })
    .select('id, phone, shop_name, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  await ensureVendorGoLivePhotos(vendor.id);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedCustomer(phone: string) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function seedRequest(
  vendorId: string,
  customerPhone: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: `device_vm_${T}_${customerPhone}`,
      message,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function gotoVendor(page: Page) {
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
}

async function loginVendorAndGoto(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendor(page);
}

async function getVendorActive(vendorId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('is_active')
    .eq('id', vendorId)
    .single();
  if (error) throw error;
  return !!data?.is_active;
}

async function tapGoLiveToggle(page: Page) {
  await page.getByTestId('vendor-golive-btn').click();
  await page.waitForTimeout(1500);
}

/** // MISSING TESTID: needs data-testid="incoming-unread-badge" on IncomingOrdersSection.tsx */
async function getIncomingOrdersBadgeCount(page: Page): Promise<number> {
  const badge = page.locator('#vendor-incoming-orders span.rounded-full.tabular-nums');
  if (!(await badge.isVisible({ timeout: 5000 }).catch(() => false))) return 0;
  return parseInt((await badge.textContent()) ?? '0', 10);
}

async function countCustomerNotifications(
  phone: string,
  opts?: { since?: string; title?: string },
): Promise<number> {
  let query = supabaseAdmin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', phone);
  if (opts?.since) query = query.gte('created_at', opts.since);
  if (opts?.title) query = query.eq('title', opts.title);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

function myBusinessPanel(page: Page) {
  return page.getByTestId('vendor-my-business');
}

async function openMyBusinessCategories(page: Page, vendor: { id: string; phone: string }) {
  await loginVendorAndGoto(page, vendor);
  await gotoVendorSettings(page);
  await page.getByTestId('settings-vendor-tab-business').click();
  await expect(myBusinessPanel(page)).toBeVisible({ timeout: 10000 });
  await expect(myBusinessPanel(page).getByTestId('my-business-categories')).toBeVisible({
    timeout: 10000,
  });
}

/** Category chips in My Business — service mode label per category. */
function vendorShopCategorySection(page: Page) {
  return myBusinessPanel(page).getByTestId('my-business-categories');
}

/** Go-live card on /vendor — vendor-status-badge + vendor-golive-btn live here. */
function vendorGoLiveSection(page: Page) {
  return page.locator('div.mx-4.rounded-2xl.border').filter({
    has: page.getByTestId('vendor-golive-btn'),
  });
}

async function gotoVendorSettings(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
}

/** // MISSING TESTID: needs data-testid="notification-bell-btn" on NotificationBell.tsx */
function notificationBell(page: Page) {
  return page.getByRole('button', { name: L.notifBellAria });
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  for (const id of createdVendorIds) {
    const { data } = await supabaseAdmin.from('vendors').select('phone').eq('id', id).maybeSingle();
    if (data?.phone) {
      await supabaseAdmin.from('user_notifications').delete().eq('user_phone', data.phone);
    }
  }
});

// ─── ONLINE/OFFLINE TOGGLE ─────────────────────────────────────────────────

test('VM-01 — Vendor goes online', async ({ page, context }) => {
  // Help vendors require GPS on go-live (vendorOffersHelp) — without GPS the update is
  // reverted and is_active stays false. Web test mocks geolocation for Help go-live.
  const vendor = await createVendor('help', 'VM01', {
    is_active: false,
    is_banned: false,
    profile_status: 'complete',
    deletion_requested_at: null,
  });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await loginVendorAndGoto(page, vendor);
  await expect(vendorGoLiveSection(page).getByTestId('vendor-golive-btn')).toBeVisible();
  await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.offline);
  await expect(vendorGoLiveSection(page).getByText(L.tapGoOnline)).toBeVisible();
  await tapGoLiveToggle(page);
  await page.waitForTimeout(1500);
  expect(await getVendorActive(vendor.id)).toBe(true);
  await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.onlineReady);
  await expect(vendorGoLiveSection(page).getByText(L.tapGoOnline)).not.toBeVisible();
  await expect(vendorGoLiveSection(page).getByText(L.tapOffline)).toBeVisible();
});

test('VM-02 — Vendor goes offline', async ({ page }) => {
  const vendor = await createVendor('help', 'VM02', { is_active: true });
  await loginVendorAndGoto(page, vendor);
  await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.onlineReady);
  await tapGoLiveToggle(page);
  expect(await getVendorActive(vendor.id)).toBe(false);
  await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.offline);
});

test('VM-03 — Vendor offline with active accepted order — cannot go offline silently', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'VM03', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, `VM-03 ${T}`, { status: 'accepted' });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await expect(page.getByText(L.offlineActiveTitle)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: L.stayOnline }).click();
  expect(await getVendorActive(vendor.id)).toBe(true);
  await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.onlineReady);
});

test('VM-04 — Vendor goes offline with today\'s sent delivery order — customer notified', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'VM04', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  await seedRequest(vendor.id, customerPhone, `VM-04 ${T}`, {
    status: 'sent',
    delivery_slot: 'morning',
  });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await expect(page.getByText(L.offlineActiveTitle)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: L.goOfflineAnyway }).click();
  await page.waitForTimeout(2000);
  expect(await getVendorActive(vendor.id)).toBe(false);
  const count = await countCustomerNotifications(customerPhone, {
    since,
    title: L.goOfflinePendingTitle,
  });
  expect(count).toBeGreaterThan(0);
});

test('VM-05 — Vendor goes offline with tomorrow\'s delivery order — customer NOT notified', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'VM05', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  await seedRequest(vendor.id, customerPhone, `VM-05 ${T}`, {
    status: 'sent',
    delivery_slot: 'tomorrow',
    delivery_slot_deadline: tomorrowAt20Iso(),
  });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await expect(page.getByText(L.offlineActiveTitle)).not.toBeVisible({ timeout: 3000 });
  expect(await getVendorActive(vendor.id)).toBe(false);
  const count = await countCustomerNotifications(customerPhone, {
    since,
    title: L.goOfflinePendingTitle,
  });
  expect(count).toBe(0);
});

test('VM-06 — Vendor goes offline with today\'s sent booking — customer notified', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'VM06', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  await seedRequest(vendor.id, customerPhone, `VM-06 ${T}`, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: todayPlusHoursIso(2),
  });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await expect(page.getByText(L.offlineActiveTitle)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: L.goOfflineAnyway }).click();
  await page.waitForTimeout(2000);
  expect(await getVendorActive(vendor.id)).toBe(false);
  const count = await countCustomerNotifications(customerPhone, {
    since,
    title: L.goOfflinePendingTitle,
  });
  expect(count).toBeGreaterThan(0);
});

test('VM-06H — Vendor goes offline with pending Help request — customer notified', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'VM06H', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  await seedRequest(vendor.id, customerPhone, `VM-06H ${T}`, {
    status: 'sent',
  });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await expect(page.getByText(L.offlineActiveTitle)).toBeVisible({ timeout: 8000 });
  await page.getByRole('button', { name: L.goOfflineAnyway }).click();
  await page.waitForTimeout(2000);
  expect(await getVendorActive(vendor.id)).toBe(false);
  const count = await countCustomerNotifications(customerPhone, {
    since,
    title: L.goOfflinePendingTitle,
  });
  expect(count).toBeGreaterThan(0);
});

test('VM-07 — Banned vendor cannot go online', async ({ page }) => {
  const vendor = await createVendor('help', 'VM07', { is_active: false, is_banned: true });
  await loginVendorAndGoto(page, vendor);
  await expect(page.getByText(L.suspended)).toBeVisible();
  await expect(page.getByTestId('vendor-golive-btn')).not.toBeVisible();
  expect(await getVendorActive(vendor.id)).toBe(false);
});

test('VM-08 — Draft vendor (no GPS) sees amber banner', async ({ page }) => {
  // vendor_draft_banner_* (vendor_draft_banner_title/body/cta) renders in VendorSettings.tsx
  // on /settings when profile_status === 'draft' — not on /vendor incoming orders.
  const vendor = await createVendor('help', 'VM08', {
    is_active: false,
    profile_status: 'draft',
    latitude: null,
    longitude: null,
  });
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorSettings(page);
  await page.getByTestId('settings-vendor-tab-preferences').click();
  await expect(page.getByText(L.draftTitle)).toBeVisible();
  await expect(page.getByText(L.draftBody)).toBeVisible();
  await expect(page.getByRole('button', { name: L.addLocation })).toBeVisible();
});

// ─── VENDOR SHOP STATE ─────────────────────────────────────────────────────

test('VM-09 — Vendor screen shows correct service mode label', async ({ page }) => {
  const helpVendor = await createVendor('help', 'VM09H', { is_active: false });
  await openMyBusinessCategories(page, helpVendor);
  await expect(vendorShopCategorySection(page).getByText(L.modeHelp).first()).toBeVisible();

  const deliveryVendor = await createVendor('delivery', 'VM09D', { is_active: false });
  await openMyBusinessCategories(page, deliveryVendor);
  await expect(vendorShopCategorySection(page).getByText(L.modeDelivery).first()).toBeVisible();
});

test('VM-14 — Go live while unverified shows nudge but still goes online', async ({ page, context }) => {
  const vendor = await createVendor('help', 'VM14', {
    is_active: false,
    is_manual_verified: false,
    profile_status: 'complete',
  });
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await loginVendorAndGoto(page, vendor);
  await tapGoLiveToggle(page);
  await page.waitForTimeout(1500);
  expect(await getVendorActive(vendor.id)).toBe(true);
  await expect(page.getByText(/Complete verification in My Business/i)).toBeVisible({ timeout: 8000 });
});

test('VM-15 — Verified vendor can open My Business and edit base type', async ({ page }) => {
  const vendor = await createVendor('help', 'VM15', {
    is_active: false,
    is_manual_verified: true,
    profile_status: 'complete',
  });
  await loginVendorAndGoto(page, vendor);
  await gotoVendorSettings(page);
  await page.getByTestId('settings-vendor-tab-business').click();
  await expect(myBusinessPanel(page)).toBeVisible({ timeout: 10000 });
  await page.getByTestId('my-business-base-home').click();
  await myBusinessPanel(page).locator('input').nth(1).fill('Home Brand');
  await expect(page.getByTestId('my-business-save')).toBeEnabled({ timeout: 10000 });
  await page.getByTestId('my-business-save').click();
  await page.waitForTimeout(2000);
  const { data } = await supabaseAdmin.from('vendors').select('vendor_type, base_type').eq('id', vendor.id).single();
  expect(data?.vendor_type).toBe('home');
  expect(data?.base_type).toBe('home');
});

test('VM-10 — Vendor with no incoming orders sees empty state', async ({ page }) => {
  const vendor = await createVendor('help', 'VM10', { is_active: true });
  await loginVendorAndGoto(page, vendor);
  await expect(page.getByText(L.incomingEmpty)).toBeVisible();
  await expect(page.getByTestId('incoming-order-card')).toHaveCount(0);
});

test('VM-11 — Vendor sees only their own orders', async ({ page }) => {
  const vendorA = await createVendor('help', 'VM11A', { is_active: true });
  const vendorB = await createVendor('help', 'VM11B', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msgA = `VM-11-A ${T}`;
  const msgB = `VM-11-B ${T}`;
  await seedRequest(vendorA.id, customerPhone, msgA, { status: 'sent' });
  await seedRequest(vendorB.id, customerPhone, msgB, { status: 'sent' });
  await loginVendorAndGoto(page, vendorA);
  await expect(page.getByTestId('incoming-order-card').filter({ hasText: msgA })).toBeVisible();
  await expect(page.getByTestId('incoming-order-card').filter({ hasText: msgB })).not.toBeVisible();
});

// ─── NOTIFICATION — VENDOR SIDE ────────────────────────────────────────────

test('VM-12 — New order notification badge increments', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VM12', { is_active: true });
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  await loginVendorAndGoto(page, vendor);
  expect(await getIncomingOrdersBadgeCount(page)).toBe(0);
  await seedRequest(vendor.id, customerPhone, `VM-12 ${T}`, { status: 'sent' });
  await page.reload();
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  expect(await getIncomingOrdersBadgeCount(page)).toBeGreaterThan(0);
});

test('VM-13 — Vendor notification bell shows new order', async ({ page }) => {
  const vendor = await createVendor('help', 'VM13', { is_active: true });
  const notifTitle = `VM-13 alert ${T}`;
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: vendor.phone,
    type: 'order_update',
    title: notifTitle,
    body: 'Test vendor notification body',
    route: 'vendor',
    is_informational: false,
    is_read: false,
  });
  await loginVendorAndGoto(page, vendor);
  const bell = notificationBell(page);
  await expect(bell.locator('span.rounded-full')).toBeVisible({ timeout: 8000 });
  await bell.click();
  await expect(page.getByRole('heading', { name: L.notifBellTitle })).toBeVisible();
  await expect(page.getByText(notifTitle)).toBeVisible();
});
