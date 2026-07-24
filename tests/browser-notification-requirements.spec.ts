import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';
import {
  createModeVendor,
  invokeExpirePendingOrders,
  invokeWarnPendingOrdersNearDeadline,
} from './helpers/session38';
import { strings } from '../src/lib/strings';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88005${String(T).slice(-5)}`;
const DEVICE_ID = `device_nt_${T}`;
const VENDOR_DEVICE_ID = `device_nt_vendor_${T}`;

const L = {
  notifBellAria: 'Notifications',
  notifBellTitle: 'Notifications',
  markAllRead: 'Mark all read',
  acceptOrder: '✅ Accept Order',
  confirmBooking: '✅ Confirm',
  confirmDecline: 'Confirm Decline',
  declineBookingTitle: 'Decline Booking',
  declineReason: 'Not available',
  orderAcceptedBody: 'Your order has been accepted and is being prepared',
  bookingConfirmedBody: 'Your booking has been confirmed. See you soon!',
} as const;

const createdNotificationIds: string[] = [];
const createdRequestIds: string[] = [];
const createdVendorIds: string[] = [];
const createdCustomerPhones: string[] = [CUSTOMER_PHONE];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99005${String(T + vendorPhoneSeq).slice(-5)}`;
}

function hasDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

async function seedCustomer(phone = CUSTOMER_PHONE) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function seedNotification(
  userPhone: string,
  fields: {
    type: string;
    title: string;
    body: string;
    route?: string | null;
    route_params?: Record<string, string> | null;
    is_read?: boolean;
    created_at?: string;
  },
) {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .insert({
      user_phone: userPhone,
      type: fields.type,
      title: fields.title,
      body: fields.body,
      route: fields.route ?? null,
      route_params: fields.route_params ?? null,
      is_read: fields.is_read ?? false,
      ...(fields.created_at ? { created_at: fields.created_at } : {}),
    })
    .select('id')
    .single();
  if (error) throw error;
  createdNotificationIds.push(data.id);
  return data;
}

async function seedUnreadBatch(count: number, phone = CUSTOMER_PHONE) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const row = await seedNotification(phone, {
      type: 'test_unread',
      title: `NT unread ${i} ${T}`,
      body: `Body ${i}`,
      is_read: false,
    });
    ids.push(row.id);
  }
  return ids;
}

// MISSING TESTID: needs data-testid="notification-bell-btn" on NotificationBell.tsx
function notificationBellBtn(page: Page): Locator {
  return page.getByRole('button', { name: L.notifBellAria });
}

function bellUnreadBadge(page: Page): Locator {
  return notificationBellBtn(page).locator('span.rounded-full.bg-brand');
}

async function openBellSheet(page: Page) {
  await notificationBellBtn(page).click();
  await expect(page.getByRole('heading', { name: L.notifBellTitle })).toBeVisible({
    timeout: 10000,
  });
}

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
) {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `NT Vendor ${tag}`,
      shop_name: `!NT-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      ...overrides,
    })
    .select('id, phone, shop_name, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedRequest(
  vendorId: string,
  message: string,
  fields: Record<string, unknown> = {},
  customerPhone = CUSTOMER_PHONE,
) {
  const service_mode = await resolveRequestServiceMode(
    vendorId,
    typeof fields.service_mode === 'string' ? fields.service_mode : null,
  );
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: DEVICE_ID,
      message,
      status: 'sent',
      ...fields,
      service_mode,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function loginVendorAndWaitOrders(
  page: Page,
  vendor: { id: string; phone: string },
) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({
    timeout: 20000,
  });
}

function incomingCard(page: Page, message: string): Locator {
  return page.getByTestId('incoming-order-card').filter({ hasText: message });
}

function futureAppointmentIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  d.setHours(14, 0, 0, 0);
  return d.toISOString();
}

/** Mirrors warnFlaggedUser inbox copy for localization checks (Settings admin warn path). */
async function simulateAdminWarn(phone: string, lang: 'en' | 'hi' | null) {
  await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 50, warn_count: 0 }, { onConflict: 'phone' });
  if (lang === null) {
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
  } else {
    await supabaseAdmin
      .from('app_users')
      .upsert({ phone, lang }, { onConflict: 'phone' });
  }
  const copy = lang === 'hi' ? strings.hi : strings.en;
  const since = new Date().toISOString();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
  const row = await seedNotification(phone, {
    type: 'account_warning',
    title: copy.warn_user_title,
    body: copy.warn_user_inbox_body,
    route: 'settings',
    is_read: false,
  });
  await supabaseAdmin
    .from('users')
    .update({ warn_count: 1, last_warned_at: new Date().toISOString() })
    .eq('phone', phone);
  return { row, since };
}

async function latestNotification(phone: string, since?: string) {
  let q = supabaseAdmin
    .from('user_notifications')
    .select('id, title, body, type, is_read, route')
    .eq('user_phone', phone)
    .order('created_at', { ascending: false })
    .limit(1);
  if (since) q = q.gte('created_at', since);
  const { data, error } = await q;
  if (error) throw error;
  return data?.[0] ?? null;
}

test.beforeAll(async () => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await seedCustomer();
});

test.afterAll(async () => {
  if (createdNotificationIds.length) {
    await supabaseAdmin.from('user_notifications').delete().in('id', createdNotificationIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test.beforeEach(async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
});

// ─── BELL — UNREAD COUNT ───────────────────────────────────────────────────

test('NT-UI-01 — Bell shows unread count badge when unread notifications exist', async ({
  page,
}) => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await seedUnreadBatch(3);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(bellUnreadBadge(page)).toBeVisible({ timeout: 15000 });
  const badgeText = await bellUnreadBadge(page).innerText();
  expect(parseInt(badgeText, 10)).toBeGreaterThanOrEqual(3);

  await supabaseAdmin
    .from('user_notifications')
    .update({ is_read: true, read_at: new Date().toISOString() })
    .eq('user_phone', CUSTOMER_PHONE)
    .eq('is_read', false);
  await page.reload();
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(bellUnreadBadge(page)).not.toBeVisible({ timeout: 10000 });
});

test('NT-UI-02 — Bell badge clears after mark all read', async ({ page }) => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await seedUnreadBatch(3);
  await page.goto(`${APP_URL}/`);
  await expect(bellUnreadBadge(page)).toBeVisible({ timeout: 15000 });
  await openBellSheet(page);
  await page.getByRole('button', { name: L.markAllRead }).click();
  await page.waitForTimeout(1000);
  await expect(bellUnreadBadge(page)).not.toBeVisible({ timeout: 10000 });

  const { count, error } = await supabaseAdmin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', CUSTOMER_PHONE)
    .eq('is_read', false);
  if (error) throw error;
  expect(count).toBe(0);
});

test('NT-UI-03 — Bell shows notifications in reverse chronological order', async ({ page }) => {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  const old = await seedNotification(CUSTOMER_PHONE, {
    type: 'order',
    title: `NT-OLD-${T}`,
    body: 'oldest',
  });
  const mid = await seedNotification(CUSTOMER_PHONE, {
    type: 'order',
    title: `NT-MID-${T}`,
    body: 'middle',
  });
  const newest = await seedNotification(CUSTOMER_PHONE, {
    type: 'order',
    title: `NT-NEW-${T}`,
    body: 'newest',
  });
  const base = Date.now();
  await supabaseAdmin
    .from('user_notifications')
    .update({ created_at: new Date(base - 3 * 60_000).toISOString() })
    .eq('id', old.id);
  await supabaseAdmin
    .from('user_notifications')
    .update({ created_at: new Date(base - 2 * 60_000).toISOString() })
    .eq('id', mid.id);
  await supabaseAdmin
    .from('user_notifications')
    .update({ created_at: new Date(base - 1 * 60_000).toISOString() })
    .eq('id', newest.id);

  await page.goto(`${APP_URL}/`);
  await openBellSheet(page);
  // MISSING TESTID: needs data-testid="notification-list-item" on NotificationBell.tsx
  const firstTitle = page.locator('ul.space-y-2 li button').first().locator('p.font-semibold');
  await expect(firstTitle).toHaveText(`NT-NEW-${T}`);
  await expect(page.getByText(`NT-OLD-${T}`)).toBeVisible();
});

// ─── DEEP-LINK ROUTING ─────────────────────────────────────────────────────

test('NT-DL-01 — Order notification routes to My Orders', async ({ page }) => {
  const title = `NT-DL-01-${T}`;
  await seedNotification(CUSTOMER_PHONE, {
    type: 'order_accepted',
    title,
    body: 'Your order was accepted',
    route: 'my-orders',
  });
  await page.goto(`${APP_URL}/`);
  await openBellSheet(page);
  await page.getByRole('button', { name: title }).click();
  await expect(page).toHaveURL(/\/my-orders/, { timeout: 15000 });
  await expect(page.getByTestId('my-orders-screen')).toBeVisible();
});

test('NT-DL-02 — Vendor notification routes to vendor screen', async ({ page }) => {
  const vendor = await createVendor('delivery', 'DL02');
  const title = `NT-DL-02-${T}`;
  await seedNotification(vendor.phone, {
    type: 'new_order',
    title,
    body: 'New order received',
    route: 'vendor',
  });
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await openBellSheet(page);
  await page.getByRole('button', { name: title }).click();
  await expect(page).toHaveURL(/\/vendor/, { timeout: 15000 });
  await expect(page.getByTestId('vendor-screen')).toBeVisible();
});

test('NT-DL-03 — Feed notification routes to feed', async ({ page }) => {
  const title = `NT-DL-03-${T}`;
  await seedNotification(CUSTOMER_PHONE, {
    type: 'feed_reply',
    title,
    body: 'Someone replied to your post',
    route: 'feed',
  });
  await page.goto(`${APP_URL}/`);
  await openBellSheet(page);
  await page.getByRole('button', { name: title }).click();
  await expect(page).toHaveURL(/\/feed/, { timeout: 15000 });
  await expect(page.getByTestId('feed-screen')).toBeVisible();
});

test('NT-DL-04 — Expired order notification routes to My Orders', async ({ page }) => {
  const title = `NT-DL-04-${T}`;
  await seedNotification(CUSTOMER_PHONE, {
    type: 'order_expired',
    title,
    body: 'Your order expired',
    route: 'my-orders',
  });
  await page.goto(`${APP_URL}/`);
  await openBellSheet(page);
  await page.getByRole('button', { name: title }).click();
  await expect(page).toHaveURL(/\/my-orders/, { timeout: 15000 });
  await expect(page.getByTestId('my-orders-screen')).toBeVisible();
  await expect(page.getByTestId('home-screen')).not.toBeVisible();
});

// ─── NOTIFICATION COPY — ORDER STATUS CHANGES ──────────────────────────────

test('NT-COPY-01 — Vendor accepts delivery order → customer notification has correct copy', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'COPY01');
  const msg = `NT-COPY-01-${T}`;
  const since = new Date().toISOString();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await seedRequest(vendor.id, msg, { status: 'seen' });
  await loginVendorAndWaitOrders(page, vendor);
  await incomingCard(page, msg).getByTestId('incoming-accept-btn').click();
  await page.waitForTimeout(2000);

  await expect
    .poll(async () => latestNotification(CUSTOMER_PHONE, since), { timeout: 15000 })
    .not.toBeNull();
  const row = await latestNotification(CUSTOMER_PHONE, since);
  expect(row?.title).toBeTruthy();
  expect(row?.body).toBeTruthy();
  expect(row?.body).toContain(L.orderAcceptedBody);
  expect(row?.body).not.toMatch(/status_accepted_delivery|incoming_orderAcceptedBody/);
});

test('NT-COPY-02 — Vendor confirms booking → customer notification has correct copy', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'COPY02');
  const msg = `NT-COPY-02-${T}`;
  const since = new Date().toISOString();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await seedRequest(vendor.id, msg, {
    status: 'seen',
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  await incomingCard(page, msg).getByTestId('incoming-accept-btn').click();
  await page.waitForTimeout(2000);

  const row = await latestNotification(CUSTOMER_PHONE, since);
  expect(row?.body).toBeTruthy();
  expect(row?.body?.toLowerCase()).toContain('confirm');
  expect(row?.body?.toLowerCase()).not.toContain('accepted');
  expect(row?.body).toContain(L.bookingConfirmedBody);
});

test('NT-COPY-03 — Vendor declines booking → customer notification has correct copy', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'COPY03', {
    cancel_reason_1: L.declineReason,
  });
  const msg = `NT-COPY-03-${T}`;
  const since = new Date().toISOString();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  await seedRequest(vendor.id, msg, {
    status: 'seen',
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await card.getByTestId('incoming-decline-btn').click();
  await expect(page.getByRole('heading', { name: L.declineBookingTitle })).toBeVisible({
    timeout: 10000,
  });
  await page.getByRole('button', { name: L.declineReason, exact: true }).click();
  await page.getByRole('button', { name: L.confirmDecline }).click();
  await page.waitForTimeout(2000);

  const row = await latestNotification(CUSTOMER_PHONE, since);
  expect(row?.body).toBeTruthy();
  expect(row?.body?.toLowerCase()).toMatch(/declined|not available/);
  expect(row?.body?.toLowerCase()).not.toContain('cancelled');
});

test('NT-COPY-04 — Order expired notification body — delivery slot name present', async () => {
  const vendor = await createModeVendor('delivery', nextVendorPhone());
  createdVendorIds.push(vendor.id);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await seedRequest(vendor.id, `NT-COPY-04-${T}`, {
    delivery_slot: 'morning',
    delivery_slot_deadline: pastDeadline,
  });
  await invokeExpirePendingOrders();

  const row = await latestNotification(CUSTOMER_PHONE);
  expect(row?.type).toBe('order_expired');
  expect(row?.body?.toLowerCase()).toContain('morning');
});

test('NT-COPY-05 — Order expired notification body — booking datetime present', async () => {
  const vendor = await createModeVendor('appointment', nextVendorPhone());
  createdVendorIds.push(vendor.id);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  const pastAppt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await seedRequest(vendor.id, `NT-COPY-05-${T}`, {
    appointment_time: pastAppt,
    appointment_status: 'pending',
  });
  await invokeExpirePendingOrders();

  const row = await latestNotification(CUSTOMER_PHONE);
  expect(row?.type).toBe('order_expired');
  expect(row?.body).toMatch(/\d{1,2}\s+[A-Z][a-z]{2}/);
});

// ─── ADMIN WARN — LOCALIZED NOTIFICATION ───────────────────────────────────

test('NT-LANG-01 — Admin warns Hindi user — notification in Hindi', async () => {
  const phone = `88005${String(T + 1).slice(-5)}`;
  createdCustomerPhones.push(phone);
  await simulateAdminWarn(phone, 'hi');
  const row = await latestNotification(phone);
  expect(row?.body).toBeTruthy();
  expect(hasDevanagari(row!.body)).toBe(true);
  expect(hasDevanagari(row!.title)).toBe(true);
});

test('NT-LANG-02 — Admin warns English user — notification in English', async () => {
  const phone = `88005${String(T + 2).slice(-5)}`;
  createdCustomerPhones.push(phone);
  await simulateAdminWarn(phone, 'en');
  const row = await latestNotification(phone);
  expect(row?.body).toBeTruthy();
  expect(hasDevanagari(row!.body)).toBe(false);
});

test('NT-LANG-03 — Admin warns user with no lang set — defaults to English', async () => {
  const phone = `88005${String(T + 3).slice(-5)}`;
  createdCustomerPhones.push(phone);
  await simulateAdminWarn(phone, null);
  const row = await latestNotification(phone);
  expect(row?.body).toBeTruthy();
  expect(hasDevanagari(row!.body)).toBe(false);
  expect(row?.body).toBe(strings.en.warn_user_inbox_body);
});

// ─── NOTIFICATION DEDUP ────────────────────────────────────────────────────

test('NT-DEDUP-01 — Near-deadline warning sent only once per customer+vendor pair', async () => {
  const vendor = await createModeVendor('delivery', nextVendorPhone());
  createdVendorIds.push(vendor.id);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  const deadline = new Date(Date.now() + 25 * 60 * 1000).toISOString();
  const orderA = await seedRequest(vendor.id, `NT-DEDUP-01A-${T}`, {
    delivery_slot: 'evening',
    delivery_slot_deadline: deadline,
  });
  const orderB = await seedRequest(vendor.id, `NT-DEDUP-01B-${T}`, {
    delivery_slot: 'evening',
    delivery_slot_deadline: deadline,
  });

  await invokeWarnPendingOrdersNearDeadline();
  await invokeWarnPendingOrdersNearDeadline();

  const { data: notifs } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE)
    .in('type', ['order_near_deadline_unseen', 'order_near_deadline_unconfirmed']);
  expect(notifs?.length).toBe(1);

  const { data: orders } = await supabaseAdmin
    .from('requests')
    .select('near_deadline_warned_at')
    .in('id', [orderA.id, orderB.id]);
  expect(orders?.every((o) => o.near_deadline_warned_at)).toBe(true);
});

test('NT-DEDUP-02 — Expiry notification — one per customer per cron run', async () => {
  const vendor = await createModeVendor('delivery', nextVendorPhone());
  createdVendorIds.push(vendor.id);
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', CUSTOMER_PHONE);
  const pastDeadline = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await seedRequest(vendor.id, `NT-DEDUP-02A-${T}`, {
    delivery_slot: 'evening',
    delivery_slot_deadline: pastDeadline,
  });
  await seedRequest(vendor.id, `NT-DEDUP-02B-${T}`, {
    delivery_slot: 'morning',
    delivery_slot_deadline: pastDeadline,
  });

  await invokeExpirePendingOrders();

  const { data: notifs } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_phone', CUSTOMER_PHONE)
    .eq('type', 'order_expired');
  expect(notifs?.length).toBe(1);
});

// ─── VENDOR BELL ───────────────────────────────────────────────────────────

test('NT-VEN-01 — Vendor bell shows new order notification', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VEN01');
  const title = `NT-VEN-01-${T}`;
  await seedNotification(vendor.phone, {
    type: 'new_order',
    title,
    body: 'You have a new delivery order',
    route: 'vendor',
  });
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 15000 });
  await expect(bellUnreadBadge(page)).toBeVisible({ timeout: 15000 });
  await openBellSheet(page);
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.getByText(title).locator('..').locator('..')).toBeVisible();
});

test('NT-VEN-02 — Vendor bell clears after read', async ({ page }) => {
  const vendor = await createVendor('delivery', 'VEN02');
  const title = `NT-VEN-02-${T}`;
  const row = await seedNotification(vendor.phone, {
    type: 'new_order',
    title,
    body: 'Unread vendor notification',
    route: 'vendor',
    is_read: false,
  });
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await openBellSheet(page);
  await page.getByRole('button', { name: title }).click();
  await page.waitForTimeout(1000);

  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('is_read')
    .eq('id', row.id)
    .single();
  expect(data?.is_read).toBe(true);
});
