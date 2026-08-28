import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  getActiveCategoryByLabel,
  seedOrderBill,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const VENDOR_DEVICE_ID = `device_io_vendor_${T}`;
/** Plain booking message — no location tag (stripLocationTag removes [I'll visit your shop]). */
const BOOKING_MSG = `BOOKING-TEST-${T}`;

// English strings (strings.en) — requirement keys referenced in test names
const L = {
  btnAccept: '✅ Accept',
  acceptOrder: '✅ Accept Order',
  btnConfirm: '✅ Confirm',
  btnDecline: '❌ Decline',
  cancelOrder: 'Cancel Order',
  confirmCancel: 'Confirm Cancel',
  markDone: 'Mark Done',
  dismiss: '✅ Dismiss',
  bookingConfirmed: 'Booking Confirmed',
  bannerDeclined: '❌ Booking Declined',
  orderCancelled: 'Order cancelled',
  slotMorning: 'Morning (before 12pm)',
  callBridge: '📞 Connect via AI-Bridge',
  flagReport: '🚩 Report an issue with this order',
  fulfilledNotifyTitle: 'Service completed',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99001${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88001${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

function futureAppointmentIso(daysAhead = 7): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

async function seedCustomer(phone: string) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

type VendorRow = { id: string; phone: string; shop_name: string; service_mode: string };

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const shopName = `!IO-${tag}-${T}`;
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `IO Vendor ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      cancel_reason_1: 'Too busy',
      cancel_reason_2: 'Out of stock',
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
  customerPhone: string,
  message: string,
  fields: Record<string, unknown> = {},
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
      device_id: `device_io_${T}_${customerPhone}`,
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

async function gotoVendor(page: Page) {
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
}

async function gotoVendorAndWaitOrders(page: Page) {
  await gotoVendor(page);
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
}

function incomingCard(page: Page, message: string): Locator {
  return page.getByTestId('incoming-order-card').filter({ hasText: message });
}

async function loginVendorAndGo(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendor(page);
}

async function loginVendorAndWaitOrders(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorAndWaitOrders(page);
}

/** // MISSING TESTID: needs data-testid="incoming-unread-badge" on IncomingOrdersSection.tsx */
async function getIncomingBadgeCount(page: Page): Promise<number> {
  const badge = page.locator('#vendor-incoming-orders span.rounded-full.tabular-nums');
  if (!(await badge.isVisible({ timeout: 5000 }).catch(() => false))) return 0;
  return parseInt((await badge.textContent()) ?? '0', 10);
}

async function getRequestRow(requestId: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('status, appointment_status')
    .eq('id', requestId)
    .single();
  if (error) throw error;
  return data;
}

async function countCustomerNotifications(phone: string, since?: string): Promise<number> {
  let query = supabaseAdmin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', phone);
  if (since) query = query.gte('created_at', since);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

function acceptBtn(card: Locator): Locator {
  return card.getByTestId('incoming-accept-btn');
}

/** Help/delivery decline is Cancel Order; booking uses incoming-decline-btn. */
function declineBtn(card: Locator): Locator {
  return card
    .getByTestId('incoming-decline-btn')
    .or(card.getByRole('button', { name: L.cancelOrder }));
}

function markDoneBtn(card: Locator): Locator {
  return card.getByTestId('incoming-done-btn');
}

/** // MISSING TESTID: needs data-testid="incoming-dismiss-btn" on IncomingOrdersSection.tsx */
function dismissBtn(card: Locator): Locator {
  return card.getByRole('button', { name: L.dismiss });
}

/**
 * Accepted orders may show a call button when Exotel is configured (no testid in app today).
 * // Call button requires Exotel config — assert presence of call action container instead.
 */
async function assertCallActionVisible(card: Locator, customerPhone: string) {
  const callButton = card
    .getByTestId('call-btn')
    .or(card.getByRole('button', { name: L.callBridge }));
  const callVisible = await callButton.isVisible({ timeout: 5000 }).catch(() => false);
  if (callVisible) {
    await expect(callButton).toBeVisible();
    return;
  }
  const last4 = customerPhone.replace(/\D/g, '').slice(-4);
  await expect(card.getByText(`••••${last4}`)).toBeVisible();
}

/** // MISSING TESTID: needs data-testid="incoming-flag-btn" on IncomingOrdersSection.tsx */
function flagBtn(card: Locator): Locator {
  return card.getByRole('button', { name: L.flagReport });
}

async function vendorDeclineViaCancelSheet(page: Page, card: Locator) {
  await card.getByRole('button', { name: L.cancelOrder }).click();
  await page.getByRole('button', { name: 'Too busy' }).click();
  await page.getByRole('button', { name: L.confirmCancel }).click();
  await page.waitForTimeout(1500);
}

test.beforeAll(async () => {
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
  }
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
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
});

// ─── HELP MODE — INCOMING ORDERS ───────────────────────────────────────────

test('IO-HELP-01 — Help order status=sent', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP01');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-HELP-01 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, { status: 'sent' });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(acceptBtn(card)).toBeVisible();
  await expect(declineBtn(card)).toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
  await expect(card.getByText(L.bookingConfirmed)).not.toBeVisible();
});

test('IO-HELP-02 — Help order status=accepted', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP02');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-HELP-02 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, { status: 'accepted' });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(markDoneBtn(card)).toBeVisible();
  await assertCallActionVisible(card, customerPhone);
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(declineBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-HELP-03 — Help order status=cancelled (customer cancelled)', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP03');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-HELP-03 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'cancelled',
    cancel_reason: 'Customer cancelled',
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText('Customer cancelled')).toBeVisible();
  await expect(dismissBtn(card)).toBeVisible();
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
});

test('IO-HELP-04 — Vendor badge for help mode', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP04');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { id } = await seedRequest(vendor.id, customerPhone, `IO-HELP-04-${i} ${T}`, {
      status: 'sent',
    });
    ids.push(id);
  }
  await loginVendorAndWaitOrders(page, vendor);
  expect(await getIncomingBadgeCount(page)).toBe(3);
  for (const id of ids) {
    const row = await getRequestRow(id);
    expect(row?.status).toBe('sent');
  }
  expect(await getIncomingBadgeCount(page)).toBe(3);
});

// ─── DELIVERY MODE — INCOMING ORDERS ──────────────────────────────────────

test('IO-DEL-01 — Delivery order status=sent', async ({ page }) => {
  const vendor = await createVendor('delivery', 'DEL01');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-DEL-01 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'sent',
    delivery_slot: 'morning',
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.slotMorning)).toBeVisible();
  await expect(acceptBtn(card)).toBeVisible();
  await expect(declineBtn(card)).toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-DEL-02 — Delivery order status=seen (after vendor opens orders — bulk flip)', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL02');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-DEL-02 ${T}`;
  await seedCustomer(customerPhone);
  const { id } = await seedRequest(vendor.id, customerPhone, msg, {
    status: 'sent',
    delivery_slot: 'morning',
  });
  await loginVendorAndWaitOrders(page, vendor);
  // Cards render before vendor_mark_sent_seen finishes — poll DB
  await expect
    .poll(async () => (await getRequestRow(id))?.status, { timeout: 10000 })
    .toBe('seen');
  const card = incomingCard(page, msg);
  await expect(acceptBtn(card)).toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-DEL-03 — Delivery order status=accepted', async ({ page }) => {
  const vendor = await createVendor('delivery', 'DEL03');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-DEL-03 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'accepted',
    delivery_slot: 'morning',
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(L.slotMorning)).toBeVisible();
  await expect(markDoneBtn(card)).toBeVisible();
  await assertCallActionVisible(card, customerPhone);
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(declineBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-DEL-04 — Delivery order status=cancelled', async ({ page }) => {
  const vendor = await createVendor('delivery', 'DEL04');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-DEL-04 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'cancelled',
    cancel_reason: 'Customer cancelled',
    delivery_slot: 'morning',
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card.getByText('Customer cancelled')).toBeVisible();
  await expect(dismissBtn(card)).toBeVisible();
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
});

test('IO-DEL-05 — Vendor badge for delivery mode', async ({ page }) => {
  const vendor = await createVendor('delivery', 'DEL05');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { id } = await seedRequest(vendor.id, customerPhone, `IO-DEL-05-${i} ${T}`, {
      status: 'sent',
    });
    ids.push(id);
  }
  await loginVendorAndWaitOrders(page, vendor);
  // Cards render before vendor_mark_sent_seen finishes — poll DB
  await expect
    .poll(async () => (await getRequestRow(ids[0]))?.status, { timeout: 10000 })
    .toBe('seen');
  for (const id of ids) {
    const row = await getRequestRow(id);
    expect(row?.status).toBe('seen');
  }
  expect(await getIncomingBadgeCount(page)).toBe(3);
});

// ─── BOOKING MODE — INCOMING ORDERS ──────────────────────────────────────

test('IO-BOOK-01 — Booking status=sent, appointment_status=pending', async ({ page }) => {
  const vendor = await createVendor('appointment', 'BOOK01');
  const customerPhone = nextCustomerPhone();
  const msg = BOOKING_MSG;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(/Around/)).toBeVisible();
  await expect(acceptBtn(card)).toBeVisible();
  await expect(card.getByTestId('incoming-decline-btn')).toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
  await expect(card.getByText(L.bookingConfirmed)).not.toBeVisible();
});

test('IO-BOOK-02 — Booking status=seen, appointment_status=pending (after bulk seen)', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BOOK02');
  const customerPhone = nextCustomerPhone();
  const msg = BOOKING_MSG;
  await seedCustomer(customerPhone);
  const { id } = await seedRequest(vendor.id, customerPhone, msg, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  expect((await getRequestRow(id))?.status).toBe('seen');
  const card = incomingCard(page, msg);
  await expect(card.getByText(/Around/)).toBeVisible();
  await expect(acceptBtn(card)).toBeVisible();
  await expect(card.getByTestId('incoming-decline-btn')).toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-BOOK-03 — Booking status=seen, appointment_status=confirmed', async ({ page }) => {
  const vendor = await createVendor('appointment', 'BOOK03');
  const customerPhone = nextCustomerPhone();
  const msg = BOOKING_MSG;
  await seedCustomer(customerPhone);
  const { id } = await seedRequest(vendor.id, customerPhone, msg, {
    status: 'seen',
    appointment_status: 'confirmed',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  const row = await getRequestRow(id);
  expect(row?.status).toBe('seen');
  expect(row?.appointment_status).toBe('confirmed');
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  await expect(card.getByText(/Around/)).toBeVisible();
  await expect(card.getByText(L.bookingConfirmed)).toBeVisible();
  await expect(markDoneBtn(card)).toBeVisible();
  await assertCallActionVisible(card, customerPhone);
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(card.getByTestId('incoming-decline-btn')).not.toBeVisible();
  await expect(dismissBtn(card)).not.toBeVisible();
});

test('IO-BOOK-04 — Booking status=seen, appointment_status=declined', async ({ page }) => {
  const vendor = await createVendor('appointment', 'BOOK04');
  const customerPhone = nextCustomerPhone();
  const msg = BOOKING_MSG;
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  const beforeNotifs = await countCustomerNotifications(customerPhone);
  const { id } = await seedRequest(vendor.id, customerPhone, msg, {
    status: 'seen',
    appointment_status: 'declined',
    appointment_time: futureAppointmentIso(),
  });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  // incoming_bannerDeclined — div.text-destructive when appointment_status === 'declined'
  await expect(card.locator('div.text-destructive', { hasText: L.bannerDeclined })).toBeVisible();
  await expect(dismissBtn(card)).toBeVisible();
  await expect(acceptBtn(card)).not.toBeVisible();
  await expect(markDoneBtn(card)).not.toBeVisible();
  await dismissBtn(card).click();
  await page.waitForTimeout(1500);
  expect((await getRequestRow(id))?.status).toBe('done');
  const afterNotifs = await countCustomerNotifications(customerPhone, since);
  expect(afterNotifs).toBe(beforeNotifs);
});

test('IO-BOOK-05 — Vendor badge for booking mode', async ({ page }) => {
  const vendor = await createVendor('appointment', 'BOOK05');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const { id } = await seedRequest(
      vendor.id,
      customerPhone,
      `${BOOKING_MSG}-${i}`,
      {
        status: 'sent',
        appointment_status: 'pending',
        appointment_time: futureAppointmentIso(),
      },
    );
    ids.push(id);
  }
  await loginVendorAndWaitOrders(page, vendor);
  // Cards render before vendor_mark_sent_seen finishes — poll DB
  await expect
    .poll(async () => (await getRequestRow(ids[0]))?.status, { timeout: 10000 })
    .toBe('seen');
  for (const id of ids) {
    expect((await getRequestRow(id))?.status).toBe('seen');
  }
  expect(await getIncomingBadgeCount(page)).toBe(2);
});

// ─── CROSS-MODE RULES ────────────────────────────────────────────────────

test('IO-CROSS-01 — No customer notification on bulk seen (delivery)', async ({ page }) => {
  const vendor = await createVendor('delivery', 'CROSS01');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-CROSS-01 ${T}`;
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  const beforeNotifs = await countCustomerNotifications(customerPhone);
  const { id } = await seedRequest(vendor.id, customerPhone, msg, { status: 'sent' });
  await loginVendorAndWaitOrders(page, vendor);
  expect((await getRequestRow(id))?.status).toBe('seen');
  const afterNotifs = await countCustomerNotifications(customerPhone, since);
  expect(afterNotifs).toBe(beforeNotifs);
});

test('IO-CROSS-02 — Mark Done creates fulfilled status + customer notification', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'CROSS02');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-CROSS-02 ${T}`;
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  const { id } = await seedRequest(vendor.id, customerPhone, msg, { status: 'accepted' });
  await seedOrderBill(id, vendor.id, { user_phone: customerPhone });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await markDoneBtn(card).click();
  await page.waitForTimeout(2000);
  expect((await getRequestRow(id))?.status).toBe('fulfilled');
  const { data: notifs } = await supabaseAdmin
    .from('user_notifications')
    .select('title, body')
    .eq('user_phone', customerPhone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  expect(notifs?.length).toBeGreaterThan(0);
  expect(notifs![0].title).toBeTruthy();
  expect(notifs![0].body).toBeTruthy();
});

// Known-flaky under full-suite serial runs (5/5 pass in isolation).
// Contention: phone prefix 99001/88001 overlaps vendor-registration + uniqueTestPhone;
// shared VENDOR_DEVICE_ID across IO vendors; decline UI / notify race (status stays
// "sent" or cancel succeeds with 0 user_notifications). No product fix — leave as-is.
test('IO-CROSS-03 — Vendor decline creates cancelled status + customer notification', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'CROSS03');
  const customerPhone = nextCustomerPhone();
  const msg = `IO-CROSS-03 ${T}`;
  await seedCustomer(customerPhone);
  const since = new Date().toISOString();
  const { id } = await seedRequest(vendor.id, customerPhone, msg, { status: 'sent' });
  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  await vendorDeclineViaCancelSheet(page, card);
  expect((await getRequestRow(id))?.status).toBe('cancelled');
  const { data: notifs } = await supabaseAdmin
    .from('user_notifications')
    .select('id')
    .eq('user_phone', customerPhone)
    .gte('created_at', since)
    .limit(5);
  expect(notifs?.length).toBeGreaterThan(0);
});

test('IO-CROSS-04 — Flag button only visible on fulfilled orders, not on sent', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'CROSS04');
  const customerPhone = nextCustomerPhone();
  const sentMsg = `IO-CROSS-04-SENT-${T}`;
  const fulfilledMsg = `IO-CROSS-04-FULFILLED-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, sentMsg, { status: 'sent' });
  await seedRequest(vendor.id, customerPhone, fulfilledMsg, { status: 'fulfilled' });
  await loginVendorAndWaitOrders(page, vendor);

  const sentCard = incomingCard(page, sentMsg);
  await expect(sentCard).toBeVisible();
  await expect(flagBtn(sentCard)).not.toBeVisible();

  const fulfilledCard = incomingCard(page, fulfilledMsg);
  await expect(fulfilledCard).toBeVisible();
  await expect(flagBtn(fulfilledCard)).toBeVisible();
});

test('IO-CAT-01 — Incoming order card shows category chip from requests.category_id', async ({
  page,
}) => {
  const primaryHelp = await getActiveCategoryByServiceMode('help');
  // Prefer a secondary help-line category that differs from the vendor primary.
  let orderCategory = await getActiveCategoryByLabel('Electrician');
  if (orderCategory.id === primaryHelp.id) {
    orderCategory = await getActiveCategoryByLabel('Plumber');
  }
  if (orderCategory.id === primaryHelp.id) {
    orderCategory = await getActiveCategoryByLabel('Carpenter');
  }
  expect(orderCategory.id).not.toBe(primaryHelp.id);

  const vendor = await createVendor('help', 'CAT01');
  await seedVendorCategory(vendor.id, orderCategory, { is_primary: false });
  const customerPhone = nextCustomerPhone();
  const msg = `IO-CAT-01 ${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'sent',
    category_id: orderCategory.id,
  });
  await loginVendorAndWaitOrders(page, vendor);

  const card = incomingCard(page, msg);
  await expect(card).toBeVisible();
  const chip = card.getByTestId('incoming-order-category');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(orderCategory.label);
});

test('IO-LOAD-01: orders past first page visible via load more (not silently dropped)', async ({
  page,
}) => {
  const PAGE_SIZE = 50;
  const vendor = await createVendor('delivery', 'LOAD01');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);

  const messages: string[] = [];
  for (let i = 0; i < PAGE_SIZE + 1; i += 1) {
    const msg = `IO-LOAD-01-${String(i).padStart(2, '0')}-${T}`;
    messages.push(msg);
    await seedRequest(vendor.id, customerPhone, msg, { status: 'sent' });
  }
  const oldestMsg = messages[0]; // inserted first → lowest created_at → beyond first page

  await loginVendorAndWaitOrders(page, vendor);

  await expect(page.getByTestId('incoming-order-card')).toHaveCount(PAGE_SIZE, {
    timeout: 20000,
  });
  await expect(incomingCard(page, oldestMsg)).toHaveCount(0);
  await expect(page.getByTestId('incoming-orders-load-more')).toBeVisible();
  await expect(page.getByTestId('incoming-orders-load-more')).toContainText(
    '1 more orders — load more',
  );

  await page.getByTestId('incoming-orders-load-more').click();
  await expect(incomingCard(page, oldestMsg)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('incoming-order-card')).toHaveCount(PAGE_SIZE + 1);
});

test('IO-OVERLAP-01: soft overlap note shows only for ±30min active appointments', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'OVERLAP01');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);

  const base = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  base.setMinutes(0, 0, 0);
  const overlapA = new Date(base.getTime()).toISOString();
  const overlapB = new Date(base.getTime() + 20 * 60 * 1000).toISOString(); // +20 min
  const farAway = new Date(base.getTime() + 3 * 60 * 60 * 1000).toISOString(); // +3h

  const msgA = `IO-OVERLAP-A ${T}`;
  const msgB = `IO-OVERLAP-B ${T}`;
  const msgFar = `IO-OVERLAP-FAR ${T}`;
  const msgCancelled = `IO-OVERLAP-CX ${T}`;

  await seedRequest(vendor.id, customerPhone, msgA, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: overlapA,
  });
  await seedRequest(vendor.id, customerPhone, msgB, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: overlapB,
  });
  await seedRequest(vendor.id, customerPhone, msgFar, {
    status: 'sent',
    appointment_status: 'pending',
    appointment_time: farAway,
  });
  // Same timestamp as A but cancelled — must not trigger overlap alone for Far
  await seedRequest(vendor.id, customerPhone, msgCancelled, {
    status: 'cancelled',
    appointment_status: 'cancelled',
    appointment_time: farAway,
  });

  await loginVendorAndWaitOrders(page, vendor);

  const cardA = incomingCard(page, msgA);
  const cardB = incomingCard(page, msgB);
  const cardFar = incomingCard(page, msgFar);

  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();
  await expect(cardFar).toBeVisible();

  await expect(cardA.getByTestId('incoming-appointment-overlap')).toBeVisible();
  await expect(cardA.getByTestId('incoming-appointment-overlap')).toHaveText(
    'You have another appointment around this time',
  );
  await expect(cardB.getByTestId('incoming-appointment-overlap')).toBeVisible();
  await expect(cardFar.getByTestId('incoming-appointment-overlap')).toHaveCount(0);

  // Confirm / Decline still enabled on overlapping cards (non-blocking)
  await expect(cardA.getByTestId('incoming-accept-btn')).toBeEnabled();
  await expect(cardA.getByTestId('incoming-decline-btn')).toBeEnabled();
});
