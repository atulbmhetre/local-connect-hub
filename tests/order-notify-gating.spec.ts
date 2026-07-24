import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';

/**
 * Client notify gating (`wasOrderEngaged` + vendor phone) lives in MyOrders.tsx only.
 * RPCs `dismiss_order` / `cancel_customer_order` never call notify-vendor.
 * These tests must drive the real My Orders UI and assert inbox side effects.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88000${String(T).slice(-5)}`;
const DEVICE_ID = `device_ong_${T}`;

const NOTIFY = {
  dismissedTitle: 'Customer marked order as done',
  dismissedBody: 'The customer has marked this order as done on their end',
  cancelledTitle: 'Order cancelled by customer',
  cancelledBody: 'The customer has cancelled their order',
  yesCancel: 'Yes, Cancel',
  dismiss: '🗑 Dismiss',
  cancelBooking: 'Cancel Booking',
  cancelOrder: 'Cancel Order',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99000${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function createVendor(
  serviceMode: 'delivery' | 'appointment',
  tag: string,
  opts: { phone?: string | null } = {},
) {
  const category =
    serviceMode === 'appointment'
      ? await getActiveCategoryByLabel('Tailor')
      : await getActiveCategoryByLabel('Pharmacy');
  const phone = opts.phone === undefined ? nextVendorPhone() : opts.phone;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Vendor ${tag}`,
      shop_name: `!${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id, phone, shop_name')
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

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('order-card').first()).toBeVisible({ timeout: 15000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

async function loginAndOpenOrder(
  page: Page,
  vendorId: string,
  message: string,
  fields: Record<string, unknown>,
) {
  await seedCustomer();
  const request = await seedRequest(vendorId, message, fields);
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);
  return { card: orderCard(page, message), requestId: request.id };
}

async function fetchVendorOrderNotification(
  vendorPhone: string,
  requestId: string,
  title: string,
) {
  const { data, error } = await supabaseAdmin
    .from('user_notifications')
    .select('id, user_phone, title, body, type, route, route_params, read_at')
    .eq('user_phone', vendorPhone)
    .eq('title', title)
    .eq('type', 'order_update')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (
    data?.find(
      (row) =>
        row.route_params &&
        typeof row.route_params === 'object' &&
        (row.route_params as { order_id?: string }).order_id === requestId,
    ) ?? null
  );
}

async function waitForVendorOrderNotification(
  vendorPhone: string,
  requestId: string,
  title: string,
  expectPresent: boolean,
) {
  await expect
    .poll(
      async () => {
        const row = await fetchVendorOrderNotification(vendorPhone, requestId, title);
        return expectPresent ? row != null : row == null;
      },
      { timeout: 15000, intervals: [500, 1000] },
    )
    .toBe(true);
  return fetchVendorOrderNotification(vendorPhone, requestId, title);
}

async function cleanupVendorNotifications(vendorPhone: string, requestId: string) {
  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('id, route_params')
    .eq('user_phone', vendorPhone)
    .eq('type', 'order_update');
  const ids =
    data
      ?.filter(
        (row) =>
          row.route_params &&
          typeof row.route_params === 'object' &&
          (row.route_params as { order_id?: string }).order_id === requestId,
      )
      .map((row) => row.id) ?? [];
  if (ids.length) {
    await supabaseAdmin.from('user_notifications').delete().in('id', ids);
  }
}

test.beforeAll(async () => {
  await supabaseAdmin.from('app_users').delete().eq('phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('vendor_reviews').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('ONG-01 — markDone notifies vendor when order was engaged (accepted + overdue delivery)', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'ONG-01');
  const msg = `ONG-01 engaged dismiss ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'accepted',
    delivery_slot: 'morning',
    delivery_slot_deadline: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });

  try {
    await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();
    await card.getByTestId('order-dismiss-btn').click();

    const row = await waitForVendorOrderNotification(
      vendor.phone,
      requestId,
      NOTIFY.dismissedTitle,
      true,
    );
    expect(row?.user_phone).toBe(vendor.phone);
    expect(row?.body).toBe(NOTIFY.dismissedBody);
    expect(row?.route).toBe('vendor');
    expect(row?.read_at).toBeNull();
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-02 — markDone notifies vendor when appointment was confirmed (overdue booking)', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'ONG-02');
  const msg = `ONG-02 confirmed overdue ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'accepted',
    appointment_time: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    appointment_status: 'confirmed',
  });

  try {
    await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();
    await card.getByTestId('order-dismiss-btn').click();

    const row = await waitForVendorOrderNotification(
      vendor.phone,
      requestId,
      NOTIFY.dismissedTitle,
      true,
    );
    expect(row?.body).toBe(NOTIFY.dismissedBody);
    expect((row?.route_params as { order_id?: string })?.order_id).toBe(requestId);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-03 — markDone does not notify when order was not engaged (cancelled)', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'ONG-03');
  const msg = `ONG-03 cancelled dismiss ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'cancelled',
    cancel_reason: 'Vendor unavailable',
  });

  try {
    await expect(card.getByTestId('order-dismiss-btn')).toBeVisible();
    await card.getByTestId('order-dismiss-btn').click();
    await waitForVendorOrderNotification(vendor.phone, requestId, NOTIFY.dismissedTitle, false);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-04 — handleRemoveOrder does not notify when order was not engaged (sent)', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'ONG-04');
  const msg = `ONG-04 sent cancel ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'sent',
    delivery_slot: 'morning',
  });

  try {
    await expect(card.getByTestId('order-cancel-btn')).toBeVisible();
    await card.getByTestId('order-cancel-btn').click();
    await card.getByRole('button', { name: NOTIFY.yesCancel }).click();
    await waitForVendorOrderNotification(vendor.phone, requestId, NOTIFY.cancelledTitle, false);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-05 — cancelAppointment notifies vendor when booking was engaged (confirmed)', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'ONG-05');
  const msg = `ONG-05 cancel engaged ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'seen',
    appointment_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    appointment_status: 'confirmed',
  });

  try {
    await expect(card.getByTestId('order-cancel-btn')).toHaveText(NOTIFY.cancelBooking);
    await card.getByTestId('order-cancel-btn').click();
    await card.getByRole('button', { name: NOTIFY.yesCancel }).click();

    const row = await waitForVendorOrderNotification(
      vendor.phone,
      requestId,
      NOTIFY.cancelledTitle,
      true,
    );
    expect(row?.body).toBe(NOTIFY.cancelledBody);
    expect(row?.route).toBe('vendor');
    expect((row?.route_params as { order_id?: string })?.order_id).toBe(requestId);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-06 — cancelAppointment does not notify when booking was not engaged (pending)', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'ONG-06');
  const msg = `ONG-06 cancel not engaged ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'sent',
    appointment_time: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    appointment_status: 'pending',
  });

  try {
    await expect(card.getByTestId('order-cancel-btn')).toHaveText(NOTIFY.cancelBooking);
    await card.getByTestId('order-cancel-btn').click();
    await card.getByRole('button', { name: NOTIFY.yesCancel }).click();
    await waitForVendorOrderNotification(vendor.phone, requestId, NOTIFY.cancelledTitle, false);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});

test('ONG-07 — engaged dismiss does not notify when vendor has no phone', async ({ page }) => {
  const vendor = await createVendor('delivery', 'ONG-07');
  const msg = `ONG-07 no vendor phone ${T}`;
  const { card, requestId } = await loginAndOpenOrder(page, vendor.id, msg, {
    status: 'accepted',
    delivery_slot: 'morning',
    delivery_slot_deadline: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });

  try {
    await supabaseAdmin.from('vendors').update({ phone: '   ' }).eq('id', vendor.id);
    await page.reload();
    await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
    const reloadedCard = orderCard(page, msg);
    await expect(reloadedCard.getByTestId('order-dismiss-btn')).toBeVisible();
    await reloadedCard.getByTestId('order-dismiss-btn').click();
    await waitForVendorOrderNotification(vendor.phone, requestId, NOTIFY.dismissedTitle, false);
  } finally {
    await cleanupVendorNotifications(vendor.phone, requestId);
  }
});
