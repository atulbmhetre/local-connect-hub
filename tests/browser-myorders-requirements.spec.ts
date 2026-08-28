import { test, expect, Page, Locator } from '@playwright/test';
import {
  loginAsCustomer,
  clickRadarOrderCard,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  getActiveCategoryByLabel,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88000${String(T).slice(-5)}`;
const DEVICE_ID = `device_mo_${T}`;

// English strings (strings.en) — requirement keys referenced in test names
const L = {
  statusSent: '📤 Sent',
  statusSeen: '👀 Vendor saw your order',
  statusAcceptedDelivery: 'Vendor accepted — preparing your order',
  statusAcceptedHelp: 'Vendor accepted — on the way',
  apptAwaiting: '· ⏳ Awaiting confirmation',
  apptConfirmed: '· ✅ Vendor confirmed',
  deliveryOverdueTitle: 'Delivery window has passed',
  bookingOverdueTitle: 'Appointment time has passed',
  deliveredCta: '✅ Delivered! Tap to rate',
  appointmentFulfilledCta: '✅ Service completed — tap to rate',
  helpFulfilledCta: '✅ Vendor Helped Me',
  slotMorning: 'Morning (before 12pm)',
  trustLowTitle: 'Additional Confirmation Required',
  trustLowBody:
    'Your account has had some issues recently. Please confirm you will be available to receive this order.',
  slotExpiredToast:
    'This delivery slot has already passed. Please pick a different slot.',
  appointmentExpiredToast:
    'This appointment time has already passed. Please pick a different date and time.',
  helpDelayedPartial: 'Still waiting? You can cancel',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99000${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedCustomer(trustScore = 75) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: trustScore }, { onConflict: 'phone' });
  if (error) throw error;
}

async function createPanIndiaVendor(
  serviceMode: 'delivery' | 'appointment' | 'help',
  tag: string,
) {
  const category =
    serviceMode === 'appointment'
      ? await getActiveCategoryByLabel('Tailor')
      : serviceMode === 'delivery'
        ? await getActiveCategoryByLabel('Pharmacy')
        : await getActiveCategoryByServiceMode(serviceMode);
  const shopName = `!${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Vendor ${tag}`,
      shop_name: shopName,
      phone: nextVendorPhone(),
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id, shop_name, service_mode, category')
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
) {
  const service_mode = await resolveRequestServiceMode(
    vendorId,
    typeof fields.service_mode === 'string' ? fields.service_mode : null,
  );
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
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

/** Requirement says /orders; app route is /my-orders. */
async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 15000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

function amberWarning(card: Locator): Locator {
  return card.locator('div.rounded-lg.border.border-amber-500\\/30');
}

async function loginAndGoToOrder(
  page: Page,
  vendorId: string,
  message: string,
  fields: Record<string, unknown>,
) {
  await seedCustomer();
  await seedRequest(vendorId, message, fields);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  return orderCard(page, message);
}

async function openParchiSheet(
  page: Page,
  vendor: { id: string; shop_name: string; category?: string },
  mode: 'delivery' | 'appointment' | 'help',
) {
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  const q =
    (mode === 'appointment' || mode === 'delivery') && vendor.category
      ? `&q=${encodeURIComponent(vendor.category)}`
      : '';
  await page.goto(`${APP_URL}/radar?mode=${mode}${q}`);
  const card = page.locator(
    `[data-testid="radar-vendor-card"][data-vendor-id="${vendor.id}"]`,
  );
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByTestId('radar-vendor-card-order-btn').click({ timeout: 10000 });
  await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 20000 });
}

function amberOverdueTitle(card: Locator, title: string): Locator {
  return amberWarning(card).getByText(title, { exact: true });
}

async function openHelpParchiSheet(
  page: Page,
  vendor: { id: string; shop_name: string },
) {
  await supabaseAdmin
    .from('vendors')
    .update({ is_active: true, service_mode: 'help' })
    .eq('id', vendor.id);

  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?mode=help`);

  const byShop = page.getByTestId('radar-vendor-card').filter({ hasText: vendor.shop_name });
  await expect(byShop.first()).toBeVisible({ timeout: 20000 });
  await byShop.first().getByTestId('radar-vendor-card-order-btn').click({ timeout: 20000 });
  await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 20000 });
}

async function countCustomerRequests(): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from('requests')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', CUSTOMER_PHONE);
  if (error) throw error;
  return count ?? 0;
}

test.beforeAll(async () => {
  await supabaseAdmin.from('app_users').delete().eq('phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

// ─── DELIVERY STATES ───────────────────────────────────────────────────────

test('MO-DEL-01 — Delivery order status=sent', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'MO-DEL-01');
  const msg = `MO-DEL-01 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'sent',
    delivery_slot: 'morning',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.slotMorning)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusSent);

  await expect(card.getByText(L.statusAcceptedDelivery)).not.toBeVisible();
  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-DEL-02 — Delivery order status=seen', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'MO-DEL-02');
  const msg = `MO-DEL-02 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'seen',
    delivery_slot: 'morning',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.slotMorning)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusSeen);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-DEL-03 — Delivery order status=accepted', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'MO-DEL-03');
  const msg = `MO-DEL-03 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'accepted',
    delivery_slot: 'morning',
    delivery_slot_deadline: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusAcceptedDelivery);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-DEL-04 — Delivery accepted + overdue slot deadline', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'MO-DEL-04');
  const msg = `MO-DEL-04 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'accepted',
    delivery_slot: 'morning',
    delivery_slot_deadline: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.deliveryOverdueTitle)).toBeVisible();
  await expect(amberWarning(card)).toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();

  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-DEL-05 — Delivery order status=fulfilled', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'MO-DEL-05');
  const msg = `MO-DEL-05 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, { status: 'fulfilled' });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toHaveText(L.deliveredCta);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
});

// ─── BOOKING STATES ────────────────────────────────────────────────────────

test('MO-BOOK-01 — Booking sent + appointment pending', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'MO-BOOK-01');
  const msg = `MO-BOOK-01 msg ${T}`;
  const appt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'sent',
    appointment_time: appt,
    appointment_status: 'pending',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.apptAwaiting)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusSent);

  await expect(card.getByText(L.apptConfirmed)).not.toBeVisible();
  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-BOOK-02 — Booking seen + appointment pending', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'MO-BOOK-02');
  const msg = `MO-BOOK-02 msg ${T}`;
  const appt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'seen',
    appointment_time: appt,
    appointment_status: 'pending',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusSeen);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-BOOK-03 — Booking seen + appointment confirmed', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'MO-BOOK-03');
  const msg = `MO-BOOK-03 msg ${T}`;
  const appt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'seen',
    appointment_time: appt,
    appointment_status: 'confirmed',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.locator('span.text-muted-foreground').filter({ hasText: L.apptConfirmed })).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.apptConfirmed);

  await expect(card.getByTestId('order-status-badge')).not.toContainText(/accepted/i);
  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-BOOK-04 — Booking confirmed + overdue appointment', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'MO-BOOK-04');
  const msg = `MO-BOOK-04 msg ${T}`;
  const appt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'seen',
    appointment_time: appt,
    appointment_status: 'confirmed',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(amberOverdueTitle(card, L.bookingOverdueTitle)).toBeVisible();
  await expect(amberWarning(card)).toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();

  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-BOOK-05 — Booking fulfilled + appointment confirmed', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'MO-BOOK-05');
  const msg = `MO-BOOK-05 msg ${T}`;
  const appt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'fulfilled',
    appointment_time: appt,
    appointment_status: 'confirmed',
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toHaveText(L.appointmentFulfilledCta);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
});

// ─── HELP STATES ───────────────────────────────────────────────────────────

test('MO-HELP-01 — Help order status=sent', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'MO-HELP-01');
  const msg = `MO-HELP-01 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, { status: 'sent' });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusSent);

  await expect(card.getByText(L.slotMorning)).not.toBeVisible();
  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-HELP-02 — Help order status=accepted', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'MO-HELP-02');
  const msg = `MO-HELP-02 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, { status: 'accepted' });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByTestId('order-status-badge')).toHaveText(L.statusAcceptedHelp);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-HELP-03 — Help accepted + 2hr overdue', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'MO-HELP-03');
  const msg = `MO-HELP-03 msg ${T}`;
  const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const card = await loginAndGoToOrder(page, vendor.id, msg, {
    status: 'accepted',
    created_at: threeHoursAgo,
    updated_at: threeHoursAgo,
  });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByText(msg)).toBeVisible();
  await expect(card.getByText(L.helpDelayedPartial)).toBeVisible();
  await expect(amberWarning(card)).toBeVisible();
  await expect(card.getByTestId('order-cancel-btn')).toBeVisible();

  await expect(card.getByTestId('order-rate-btn')).not.toBeVisible();
});

test('MO-HELP-04 — Help order status=fulfilled', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'MO-HELP-04');
  const msg = `MO-HELP-04 msg ${T}`;
  const card = await loginAndGoToOrder(page, vendor.id, msg, { status: 'fulfilled' });

  await expect(card.getByText(vendor.shop_name)).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toBeVisible();
  await expect(card.getByTestId('order-rate-btn')).toHaveText(L.helpFulfilledCta);

  await expect(amberWarning(card)).not.toBeVisible();
  await expect(card.getByTestId('order-dismiss-btn')).not.toBeVisible();
});

// ─── PARCHISHEET — ORDER PLACEMENT ─────────────────────────────────────────

test('PS-DEL-01 — ParchiSheet for delivery vendor', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'PS-DEL-01');
  await seedCustomer();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openParchiSheet(page, vendor, 'delivery');

  await expect(page.getByTestId('parchi-slot-select')).toBeVisible();
  await expect(page.getByTestId('parchi-address-input')).toBeVisible();
  await expect(page.getByTestId('parchi-message-input')).toBeVisible();
  await expect(page.getByTestId('parchi-submit-btn')).toBeVisible();

  // MISSING TESTID: needs data-testid="parchi-appointment-date" on ParchiSheet date input
  await expect(page.locator('input[type="date"]')).not.toBeVisible();
  await expect(page.locator('input[type="time"]')).not.toBeVisible();
});

test('PS-BOOK-01 — ParchiSheet for booking vendor', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'PS-BOOK-01');
  await seedCustomer();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openParchiSheet(page, vendor, 'appointment');

  // MISSING TESTID: needs data-testid="parchi-appointment-date" on ParchiSheet date input
  // MISSING TESTID: needs data-testid="parchi-appointment-time" on ParchiSheet time input
  await expect(page.locator('input[type="date"]')).toBeVisible();
  await expect(page.locator('input[type="time"]')).toBeVisible();
  await expect(page.getByTestId('parchi-message-input')).toBeVisible();
  await expect(page.getByTestId('parchi-submit-btn')).toBeVisible();

  await expect(page.getByTestId('parchi-slot-select')).not.toBeVisible();
});

test('PS-HELP-01 — ParchiSheet for help vendor', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'PS-HELP-01');
  await seedCustomer();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openHelpParchiSheet(page, vendor);

  await expect(page.getByTestId('parchi-message-input')).toBeVisible();
  await expect(page.getByTestId('parchi-submit-btn')).toBeVisible();

  await expect(page.getByTestId('parchi-slot-select')).not.toBeVisible();
  await expect(page.locator('input[type="date"]')).not.toBeVisible();
  await expect(page.locator('input[type="time"]')).not.toBeVisible();
});

test('PS-HELP-02 — Help-mode placement creates requests row via ParchiSheet', async ({ page }) => {
  const vendor = await createPanIndiaVendor('help', 'PS-HELP-02');
  await supabaseAdmin
    .from('vendors')
    .update({ is_active: true, discoverable: true, profile_status: 'complete' })
    .eq('id', vendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ serves_at_vendor_place: true, serves_at_customer_place: true })
    .eq('vendor_id', vendor.id);
  await seedCustomer(80);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openHelpParchiSheet(page, vendor);

  const msg = `PS-HELP-02 help order ${T}`;
  await page.getByTestId('parchi-message-input').fill(msg);
  await page.getByTestId('parchi-help-come-to-me').click();
  await page.getByTestId('parchi-submit-btn').click();

  await expect(page.getByText('✅ Order sent! They will see it shortly.')).toBeVisible({
    timeout: 20000,
  });

  const { data: row, error } = await supabaseAdmin
    .from('requests')
    .select('id, service_mode, status, message, vendor_id, service_location')
    .eq('user_phone', CUSTOMER_PHONE)
    .eq('vendor_id', vendor.id)
    .like('message', `${msg}%`)
    .maybeSingle();
  expect(error).toBeNull();
  expect(row).toBeTruthy();
  expect(row!.service_mode).toBe('help');
  expect(row!.status).toBe('sent');
  expect(row!.service_location).toBe('customer_place');
  createdRequestIds.push(row!.id);
});

test('PS-TRUST-01 — Low trust vendor requires confirmation checkbox', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'PS-TRUST-01');
  await seedCustomer(35);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openParchiSheet(page, vendor, 'delivery');

  await page.getByTestId('parchi-address-input').fill(`Flat 1, Test Colony ${T}`);
  await page.getByTestId('parchi-message-input').fill(`Low trust order ${T}`);
  await page.getByTestId('parchi-submit-btn').click();

  await expect(page.getByText(L.trustLowTitle)).toBeVisible();
  await expect(page.getByText(L.trustLowBody)).toBeVisible();
  await expect(page.getByTestId('parchi-low-trust-checkbox')).toBeVisible();
  await expect(page.getByTestId('parchi-low-trust-confirm')).toBeDisabled();

  await page.getByTestId('parchi-low-trust-checkbox').check();
  await expect(page.getByTestId('parchi-low-trust-confirm')).toBeEnabled();
});

test('PS-PAST-SLOT-01 — Morning slot expired after 12:00', async ({ page }) => {
  const vendor = await createPanIndiaVendor('delivery', 'PS-PAST-SLOT-01');
  await page.clock.install({ time: new Date('2026-06-16T10:00:00') });
  await seedCustomer();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openParchiSheet(page, vendor, 'delivery');

  const beforeCount = await countCustomerRequests();
  await page.getByTestId('parchi-slot-select').selectOption('morning');
  await page.getByTestId('parchi-address-input').fill(`Addr ${T}`);
  await page.getByTestId('parchi-message-input').fill(`Past slot ${T}`);
  await page.clock.setFixedTime(new Date('2026-06-16T13:00:00'));
  await page.getByTestId('parchi-submit-btn').click();

  await expect(page.getByText(L.slotExpiredToast)).toBeVisible();
  const afterCount = await countCustomerRequests();
  expect(afterCount).toBe(beforeCount);
});

test('PS-PAST-APPT-01 — Past appointment rejected on submit', async ({ page }) => {
  const vendor = await createPanIndiaVendor('appointment', 'PS-PAST-APPT-01');
  await seedCustomer();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await openParchiSheet(page, vendor, 'appointment');

  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const pastDate = past.toISOString().split('T')[0];
  const pastTime = past.toTimeString().slice(0, 5);

  const beforeCount = await countCustomerRequests();
  // MISSING TESTID: needs data-testid="parchi-appointment-date" on ParchiSheet date input
  // MISSING TESTID: needs data-testid="parchi-appointment-time" on ParchiSheet time input
  await page.locator('input[type="date"]').fill(pastDate);
  await page.locator('input[type="time"]').fill(pastTime);
  await page.getByTestId('parchi-message-input').fill(`Past appt ${T}`);
  await page.getByTestId('parchi-submit-btn').click();

  await expect(page.getByText(L.appointmentExpiredToast)).toBeVisible();
  const afterCount = await countCustomerRequests();
  expect(afterCount).toBe(beforeCount);
});
