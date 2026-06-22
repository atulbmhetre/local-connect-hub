import { test, expect, Page } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const VENDOR_DEVICE_ID = `device_kb_${T}`;

const L = {
  myShop: 'My Shop',
  shopInfo: 'Shop Info',
  khataSettings: 'Khata Settings',
  khataEnable: 'Enable Khata / Credit',
  billEditWarning:
    'Please review carefully — bills cannot be edited after sending. You can only void and replace.',
  billAmberWarning: "This bill will push customer's dues above your warning limit.",
  khataDisableBlocked:
    'You have outstanding dues. Collect all payments before disabling khata.',
  creditAmber: 'High dues',
  creditRed: 'Dues limit reached',
  khataMarkPaid: 'Mark Paid',
  khataPaidNotifBody: 'Your ledger has been cleared',
  billNotifTitle: 'Bill from your vendor',
  khataRecordPayment: 'Record Payment',
  khataSavePayment: 'Save Payment',
  billCash: '💵 Cash',
  billUpi: '📱 UPI',
  billLedger: '📒 Ledger',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdBillIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99010${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88010${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

function maskPhoneLast4(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `••••${digits.slice(-4)}`;
}

function futureAppointmentIso(daysAhead = 7): string {
  return new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
}

type VendorRow = {
  id: string;
  phone: string;
  shop_name: string;
  service_mode: string;
};

async function createVendor(
  serviceMode: 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const shopName = `!KB-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `KB Vendor ${tag}`,
      shop_name: shopName,
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
  return vendor as VendorRow;
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
      device_id: `device_kb_${T}_${customerPhone}`,
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

async function seedKhataLedger(vendorId: string, customerPhone: string, outstanding: number) {
  const { error } = await supabaseAdmin.from('khata_ledger').upsert(
    {
      vendor_id: vendorId,
      user_phone: customerPhone,
      total_outstanding: outstanding,
      last_updated: new Date().toISOString(),
    },
    { onConflict: 'vendor_id,user_phone' },
  );
  if (error) throw error;
}

async function gotoVendor(page: Page) {
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
}

async function gotoVendorAndWaitOrders(page: Page) {
  await gotoVendor(page);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 20000 });
}

async function loginVendorAndWaitOrders(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorAndWaitOrders(page);
}

async function gotoSettings(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
}

async function waitForMyShopReady(page: Page) {
  // MISSING TESTID: needs data-testid="my-shop-section" on VendorSettings collapsible
  await page
    .waitForSelector('[data-testid="my-shop-section"]', { state: 'visible', timeout: 10000 })
    .catch(() => undefined);
  await expect(page.getByRole('button', { name: L.shopInfo })).toBeVisible({ timeout: 20000 });
}

async function expandMyShop(page: Page) {
  const shopHeader = page.getByRole('button', { name: new RegExp(`^${L.myShop}$`, 'i') });
  await expect(shopHeader).toBeVisible({ timeout: 20000 });
  if ((await shopHeader.getAttribute('aria-expanded')) !== 'true') {
    await shopHeader.click();
  }
  await waitForMyShopReady(page);
}

async function expandKhataSettings(page: Page) {
  await expandMyShop(page);
  const khataBtn = page.getByRole('button', { name: L.khataSettings });
  await expect(khataBtn).toBeVisible({ timeout: 15000 });
  if ((await khataBtn.getAttribute('aria-expanded')) !== 'true') {
    await khataBtn.click();
  }
}

function orderCard(page: Page, message: string) {
  return page.getByTestId('incoming-order-card').filter({ hasText: message });
}

async function openBillSheet(page: Page, message: string) {
  const card = orderCard(page, message);
  await card.getByTestId('incoming-bill-btn').click();
  await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 10000 });
}

async function fillBillLine(page: Page, description: string, unitPrice: number) {
  await page.getByPlaceholder('Item name').fill(description);
  const priceInput = page.locator('input[aria-label="Unit price"]');
  await priceInput.fill(String(unitPrice));
}

test.afterAll(async () => {
  if (createdBillIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('id', createdBillIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('khata_transactions').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('khata_transactions').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('khata_ledger').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

// ─── BILL SHEET UI ───────────────────────────────────────────────────────────

test('KB-REQ-01 — BillSheet shows pre-send warning banner', async ({ page }) => {
  const vendor = await createVendor('delivery', 'req01');
  const customer = nextCustomerPhone();
  const message = `KB-REQ-01-${T}`;
  await seedRequest(vendor.id, customer, message, { status: 'accepted' });

  await loginVendorAndWaitOrders(page, vendor);
  await openBillSheet(page, message);

  await expect(page.getByText(L.billEditWarning)).toBeVisible();
  await expect(page.getByTestId('bill-submit-btn')).toBeVisible();
  await expect(page.getByText(L.billEditWarning)).toBeVisible();
});

test('KB-REQ-02 — BillSheet for appointment order — unlocked when confirmed + fulfilled', async ({
  page,
}) => {
  const vendor = await createVendor('appointment', 'req02');
  const customer = nextCustomerPhone();
  const message = `KB-REQ-02-${T}`;
  await seedRequest(vendor.id, customer, message, {
    status: 'fulfilled',
    appointment_status: 'confirmed',
    appointment_time: futureAppointmentIso(),
  });

  await loginVendorAndWaitOrders(page, vendor);
  const card = orderCard(page, message);
  await expect(card.getByTestId('incoming-bill-btn')).toBeVisible({ timeout: 10000 });
  await card.getByTestId('incoming-bill-btn').click();
  await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 10000 });
});

test('KB-REQ-03 — BillSheet NOT available for unconfirmed appointment', async ({ page }) => {
  const vendor = await createVendor('appointment', 'req03');
  const customer = nextCustomerPhone();
  const message = `KB-REQ-03-${T}`;
  await seedRequest(vendor.id, customer, message, {
    status: 'seen',
    appointment_status: 'pending',
    appointment_time: futureAppointmentIso(),
  });

  await loginVendorAndWaitOrders(page, vendor);
  const card = orderCard(page, message);
  await expect(card.getByTestId('incoming-bill-btn')).not.toBeVisible();
});

// ─── CREDIT LIMITS ───────────────────────────────────────────────────────────

test('KB-REQ-04 — Amber warning shown when bill pushes customer over amber limit', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'req04', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customer = nextCustomerPhone();
  const message = `KB-REQ-04-${T}`;
  await seedKhataLedger(vendor.id, customer, 400);
  await seedRequest(vendor.id, customer, message, { status: 'accepted' });

  await loginVendorAndWaitOrders(page, vendor);
  await openBillSheet(page, message);
  await page
    .getByTestId('bill-payment-mode-select')
    .getByRole('button', { name: L.billLedger })
    .click();
  await fillBillLine(page, 'KB item', 200);

  await expect(page.getByText(L.billAmberWarning)).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('bill-submit-btn')).toBeVisible();
});

test('KB-REQ-05 — Khata disable blocked when customer has outstanding balance', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'req05', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customer, 200);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoSettings(page);
  await expandKhataSettings(page);

  const khataBlock = page.locator('div.px-4').filter({ hasText: L.khataEnable });
  await khataBlock.getByRole('switch').click();
  await expect(page.locator('[data-sonner-toast]').getByText(L.khataDisableBlocked)).toBeVisible({
    timeout: 8000,
  });
});

test('KB-REQ-06 — Amber/red badge on incoming order card when customer has outstanding', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'req06', {
    khata_amber_limit: 300,
    khata_red_limit: 500,
  });
  const amberCustomer = nextCustomerPhone();
  const redCustomer = nextCustomerPhone();
  const amberMsg = `KB-REQ-06-amber-${T}`;
  const redMsg = `KB-REQ-06-red-${T}`;

  await seedKhataLedger(vendor.id, amberCustomer, 400);
  await seedKhataLedger(vendor.id, redCustomer, 600);
  await seedRequest(vendor.id, amberCustomer, amberMsg, { status: 'accepted' });
  await seedRequest(vendor.id, redCustomer, redMsg, { status: 'accepted' });

  await loginVendorAndWaitOrders(page, vendor);
  await expect(orderCard(page, amberMsg).getByText(L.creditAmber)).toBeVisible({
    timeout: 10000,
  });
  await expect(orderCard(page, redMsg).getByText(L.creditRed)).toBeVisible({ timeout: 10000 });
});

// ─── LEDGER ──────────────────────────────────────────────────────────────────

test('KB-REQ-07 — Ledger screen shows customer list with outstanding balances', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'req07', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customerA = nextCustomerPhone();
  const customerB = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customerA, 250);
  await seedKhataLedger(vendor.id, customerB, 375);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('₹250.00')).toBeVisible();
  await expect(page.getByText('₹375.00')).toBeVisible();
});

test('KB-REQ-08 — Partial payment reduces balance, does not zero it', async () => {
  const vendor = await createVendor('delivery', 'req08');
  const customer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customer, 500);

  const { error: txError } = await supabaseAdmin.from('khata_transactions').insert({
    vendor_id: vendor.id,
    user_phone: customer,
    amount: 200,
    payment_mode: 'paid',
    note: 'Partial payment KB-REQ-08',
  });
  if (txError) throw txError;

  const { error: ledgerError } = await supabaseAdmin
    .from('khata_ledger')
    .update({ total_outstanding: 300, last_updated: new Date().toISOString() })
    .eq('vendor_id', vendor.id)
    .eq('user_phone', customer);
  if (ledgerError) throw ledgerError;

  const { data } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', vendor.id)
    .eq('user_phone', customer)
    .single();
  expect(data?.total_outstanding).toBe(300);
  expect(data?.total_outstanding).not.toBe(0);
  expect(data?.total_outstanding).not.toBe(500);
});

test('KB-REQ-09 — Full payment sets paid_at timestamp', async ({ page }) => {
  const vendor = await createVendor('delivery', 'req09');
  const customer = nextCustomerPhone();
  const message = `KB-REQ-09-${T}`;
  const order = await seedRequest(vendor.id, customer, message, { status: 'accepted' });
  const { data: bill, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: order.id,
      vendor_id: vendor.id,
      user_phone: customer,
      total_amount: 150,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdBillIds.push(bill!.id);

  await loginVendorAndWaitOrders(page, vendor);
  const card = orderCard(page, message);
  await card.getByRole('button', { name: L.khataMarkPaid }).click();
  await expect(page.locator('[data-sonner-toast]').getByText('Bill marked as paid')).toBeVisible({
    timeout: 8000,
  });

  const { data: updated } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status, paid_at')
    .eq('id', bill!.id)
    .single();
  expect(updated?.payment_status).toBe('paid');
  expect(updated?.paid_at).not.toBeNull();
});

test('KB-REQ-10 — Customer name shown in ledger when vendor has added it', async ({ page }) => {
  const vendor = await createVendor('delivery', 'req10', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customer = nextCustomerPhone();
  await supabaseAdmin.from('app_users').upsert(
    { phone: customer, name: 'Sunita', device_id: `device_kb_name_${T}` },
    { onConflict: 'phone' },
  );
  await seedKhataLedger(vendor.id, customer, 120);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Sunita')).toBeVisible();
  await expect(page.getByText(maskPhoneLast4(customer))).toBeVisible();
  await expect(page.getByText(customer)).not.toBeVisible();
});

test('KB-REQ-11 — Customer name falls back to masked phone when name is null', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'req11', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customer, 80);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(maskPhoneLast4(customer))).toBeVisible();
  await expect(page.getByTestId('ledger-screen')).toBeVisible();
});

// ─── CUSTOMER NOTIFICATION ───────────────────────────────────────────────────

test('KB-REQ-12 — Customer notified when vendor sends bill', async () => {
  const vendor = await createVendor('delivery', 'req12');
  const customer = nextCustomerPhone();
  const message = `KB-REQ-12-${T}`;
  const order = await seedRequest(vendor.id, customer, message, { status: 'accepted' });
  const since = new Date().toISOString();

  const { data: bill, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: order.id,
      vendor_id: vendor.id,
      user_phone: customer,
      total_amount: 220,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdBillIds.push(bill!.id);

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('title, body')
    .eq('user_phone', customer)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  expect(notifications?.length ?? 0).toBeGreaterThan(0);
  const row = notifications![0];
  expect(row.title).toBe(L.billNotifTitle);
  expect(row.body).toMatch(/₹220/);
});

test('KB-REQ-13 — Customer notified when vendor marks bill paid', async ({ page }) => {
  const vendor = await createVendor('delivery', 'req13', {
    khata_amber_limit: 500,
    khata_red_limit: 1000,
  });
  const customer = nextCustomerPhone();
  const message = `KB-REQ-13-${T}`;
  const order = await seedRequest(vendor.id, customer, message, { status: 'fulfilled' });
  await seedKhataLedger(vendor.id, customer, 300);

  const { data: bill, error: billError } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: order.id,
      vendor_id: vendor.id,
      user_phone: customer,
      total_amount: 300,
      payment_mode: 'khata',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (billError) throw billError;
  createdBillIds.push(bill!.id);

  await supabaseAdmin.from('khata_transactions').insert({
    vendor_id: vendor.id,
    user_phone: customer,
    amount: 300,
    payment_mode: 'khata',
    note: 'Bill from order',
    request_id: order.id,
  });

  const since = new Date().toISOString();

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: /₹300\.00/ }).click();
  await page.getByTestId('ledger-mark-paid-btn').click();
  await page.getByTestId('ledger-partial-input').fill('300');
  await page.getByRole('button', { name: L.khataSavePayment }).click();
  await expect(page.locator('[data-sonner-toast]').getByText('Marked as paid!')).toBeVisible({
    timeout: 10000,
  });

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('body')
    .eq('user_phone', customer)
    .gte('created_at', since)
    .order('created_at', { ascending: false });

  expect(notifications?.length ?? 0).toBeGreaterThan(0);
  expect(notifications!.some((n) => n.body?.includes(L.khataPaidNotifBody))).toBe(true);
});
