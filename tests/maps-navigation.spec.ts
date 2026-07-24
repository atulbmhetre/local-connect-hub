import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_maps_vendor_${T}`;
const CUSTOMER_DEVICE_ID = `device_maps_customer_${T}`;

const COME_TO_ME = '[Come to my place]';
const VISIT_SHOP = "[I'll visit your shop]";
const MAPS_LABEL = 'Open in Maps';

const PRECISE_LAT = 18.50743;
const PRECISE_LNG = 73.80774;
const VENDOR_LAT = 18.5204;
const VENDOR_LNG = 73.8567;

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

function futureAppointmentIso(daysAhead = 7): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

function bookingSeedFields(extra: Record<string, unknown> = {}) {
  return {
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
    ...extra,
  };
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
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const shopName = `!MAPS-${tag}-${T}`;
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Maps Vendor ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: VENDOR_LAT,
      longitude: VENDOR_LNG,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      cancel_reason_1: 'Too busy',
      cancel_reason_2: 'Out of stock',
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
      device_id: CUSTOMER_DEVICE_ID,
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

async function installMapsOpenCapture(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __mapsOpens: string[] }).__mapsOpens = [];
    window.open = ((url?: string | URL) => {
      (window as unknown as { __mapsOpens: string[] }).__mapsOpens.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  });
}

async function lastMapsOpenUrl(page: Page): Promise<string> {
  return page.evaluate(
    () => (window as unknown as { __mapsOpens: string[] }).__mapsOpens.at(-1) ?? '',
  );
}

async function clickMapsAndGetUrl(page: Page, btn: Locator): Promise<string> {
  await btn.click();
  return lastMapsOpenUrl(page);
}

function expectCoordsUrl(url: string, lat: number, lng: number) {
  expect(url).toBe(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`);
}

function expectAddressUrl(url: string, address: string) {
  expect(url).toBe(
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
  );
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

async function loginVendorAndWaitOrders(page: Page, vendor: VendorRow) {
  await installMapsOpenCapture(page);
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorAndWaitOrders(page);
}

async function loginCustomerAndGoOrders(page: Page, customerPhone: string) {
  await installMapsOpenCapture(page);
  await loginAsCustomer(page, customerPhone, CUSTOMER_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

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

// ─── Vendor — Delivery ───────────────────────────────────────────────────────

test('MAPS-E2E-01: delivery order with coords → vendor sees Open in Maps → coords link', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL01');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-01-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  const mapsBtn = card.getByTestId('incoming-open-maps-btn');
  await expect(mapsBtn).toBeVisible();
  await expect(mapsBtn).toContainText(MAPS_LABEL);

  const url = await clickMapsAndGetUrl(page, mapsBtn);
  expectCoordsUrl(url, PRECISE_LAT, PRECISE_LNG);
});

test('MAPS-E2E-02: delivery order address only → vendor sees Open in Maps → address search', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL02');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-02-${T}`;
  const address = '221B Baker Street, Pune';
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, { delivery_address: address });

  await loginVendorAndWaitOrders(page, vendor);
  const mapsBtn = incomingCard(page, msg).getByTestId('incoming-open-maps-btn');
  await expect(mapsBtn).toBeVisible();

  const url = await clickMapsAndGetUrl(page, mapsBtn);
  expectAddressUrl(url, address);
});

test('MAPS-E2E-03: delivery order with no coords, no address → Maps button not rendered', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL03');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-03-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg);

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, msg).getByTestId('incoming-open-maps-btn')).not.toBeVisible();
});

test('MAPS-E2E-04: delivery order status=completed → Maps button not rendered', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL04');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-04-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'completed',
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  await installMapsOpenCapture(page);
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendor(page);

  // Completed orders fall outside the vendor active window — no card, no maps button.
  await expect(incomingCard(page, msg)).not.toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId('incoming-open-maps-btn')).toHaveCount(0);
});

test('MAPS-E2E-05: delivery order status=cancelled → Maps button not rendered', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'DEL05');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-05-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    status: 'cancelled',
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, msg).getByTestId('incoming-open-maps-btn')).not.toBeVisible();
});

// ─── Vendor — Help ───────────────────────────────────────────────────────────

test('MAPS-E2E-06: help order with coords → helper sees Maps button', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP06');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-06-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, msg).getByTestId('incoming-open-maps-btn')).toBeVisible();
});

test('MAPS-E2E-07: help order without coords → Maps button not rendered', async ({ page }) => {
  const vendor = await createVendor('help', 'HELP07');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-07-${T}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg);

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, msg).getByTestId('incoming-open-maps-btn')).not.toBeVisible();
});

// ─── Vendor — Booking ────────────────────────────────────────────────────────

test('MAPS-E2E-08: booking come to me with coords → vendor sees Maps button → coords link', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BKG08');
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-08-${T}`;
  const msg = `${COME_TO_ME} ${tag}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  }));

  await loginVendorAndWaitOrders(page, vendor);
  const mapsBtn = incomingCard(page, tag).getByTestId('incoming-open-maps-btn');
  await expect(mapsBtn).toBeVisible();
  const url = await clickMapsAndGetUrl(page, mapsBtn);
  expectCoordsUrl(url, PRECISE_LAT, PRECISE_LNG);
});

test('MAPS-E2E-09: booking come to me, address only → vendor sees Maps button → address link', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BKG09');
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-09-${T}`;
  const msg = `${COME_TO_ME} ${tag}`;
  const address = 'Flat 5, FC Road, Pune';
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({ delivery_address: address }));

  await loginVendorAndWaitOrders(page, vendor);
  const mapsBtn = incomingCard(page, tag).getByTestId('incoming-open-maps-btn');
  await expect(mapsBtn).toBeVisible();
  const url = await clickMapsAndGetUrl(page, mapsBtn);
  expectAddressUrl(url, address);
});

test('MAPS-E2E-10: booking I will come to you → Maps button NOT shown on vendor side', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BKG10');
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-10-${T}`;
  const msg = `${VISIT_SHOP} ${tag}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  }));

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, tag).getByTestId('incoming-open-maps-btn')).not.toBeVisible();
});

// ─── Customer — Booking ──────────────────────────────────────────────────────

test('MAPS-E2E-11: booking I will come to you → customer sees Maps button → vendor coords link', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BKG11');
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-11-${T}`;
  const msg = `${VISIT_SHOP} ${tag}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({ status: 'accepted' }));

  await loginCustomerAndGoOrders(page, customerPhone);
  const mapsBtn = orderCard(page, tag).getByTestId('myorders-open-maps-btn');
  await expect(mapsBtn).toBeVisible();
  const url = await clickMapsAndGetUrl(page, mapsBtn);
  expectCoordsUrl(url, VENDOR_LAT, VENDOR_LNG);
});

test('MAPS-E2E-12: booking I will come to you, vendor has no lat/long → Maps button not shown', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'BKG12', {
    latitude: null,
    longitude: null,
  });
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-12-${T}`;
  const msg = `${VISIT_SHOP} ${tag}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({ status: 'accepted' }));

  await loginCustomerAndGoOrders(page, customerPhone);
  await expect(orderCard(page, tag).getByTestId('myorders-open-maps-btn')).not.toBeVisible();
});

test('MAPS-E2E-13: booking come to me → customer does NOT see Maps button', async ({ page }) => {
  const vendor = await createVendor('appointment', 'BKG13');
  const customerPhone = nextCustomerPhone();
  const tag = `MAPS-E2E-13-${T}`;
  const msg = `${COME_TO_ME} ${tag}`;
  await seedCustomer(customerPhone);
  await seedRequest(vendor.id, customerPhone, msg, bookingSeedFields({
    status: 'accepted',
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  }));

  await loginCustomerAndGoOrders(page, customerPhone);
  await expect(orderCard(page, tag).getByTestId('myorders-open-maps-btn')).not.toBeVisible();
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('MAPS-E2E-14: accepted → completed → Maps button disappears without reload', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'RT14');
  const customerPhone = nextCustomerPhone();
  const msg = `MAPS-E2E-14-${T}`;
  await seedCustomer(customerPhone);
  const request = await seedRequest(vendor.id, customerPhone, msg, {
    status: 'accepted',
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const { error: billError } = await supabaseAdmin.from('order_bills').insert({
    request_id: request.id,
    vendor_id: vendor.id,
    total_amount: 10000,
    payment_status: 'unpaid',
  });
  if (billError) throw billError;

  await loginVendorAndWaitOrders(page, vendor);
  const card = incomingCard(page, msg);
  const mapsBtn = card.getByTestId('incoming-open-maps-btn');
  await expect(mapsBtn).toBeVisible();

  const { error } = await supabaseAdmin
    .from('requests')
    .update({ status: 'fulfilled' })
    .eq('id', request.id);
  if (error) throw error;

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('requests')
          .select('status')
          .eq('id', request.id)
          .single();
        return data?.status === 'fulfilled';
      },
      { timeout: 10000 },
    )
    .toBe(true);

  // Realtime may be unavailable in CI; IncomingOrdersSection also silent-refreshes every 30s.
  await expect(mapsBtn).not.toBeVisible({ timeout: 35000 });
});

test('MAPS-E2E-15: two simultaneous active orders → Maps button on each independently', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'MULTI15');
  const customerA = nextCustomerPhone();
  const customerB = nextCustomerPhone();
  const msgA = `MAPS-E2E-15A-${T}`;
  const msgB = `MAPS-E2E-15B-${T}`;
  await seedCustomer(customerA);
  await seedCustomer(customerB);
  await seedRequest(vendor.id, customerA, msgA, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });
  await seedRequest(vendor.id, customerB, msgB, {
    customer_latitude: 19.076,
    customer_longitude: 72.8777,
  });

  await loginVendorAndWaitOrders(page, vendor);
  await expect(incomingCard(page, msgA).getByTestId('incoming-open-maps-btn')).toBeVisible();
  await expect(incomingCard(page, msgB).getByTestId('incoming-open-maps-btn')).toBeVisible();

  const urlA = await clickMapsAndGetUrl(
    page,
    incomingCard(page, msgA).getByTestId('incoming-open-maps-btn'),
  );
  expectCoordsUrl(urlA, PRECISE_LAT, PRECISE_LNG);

  const urlB = await clickMapsAndGetUrl(
    page,
    incomingCard(page, msgB).getByTestId('incoming-open-maps-btn'),
  );
  expectCoordsUrl(urlB, 19.076, 72.8777);
});
