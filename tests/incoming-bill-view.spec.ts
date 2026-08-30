import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_ibv_vendor_${T}`;

const L = {
  createBill: '📋 Create Bill',
  viewBill: 'View Bill',
  billTotal: 'Total',
  billCash: '💵 Cash',
  billUnpaid: '⏳ Unpaid',
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

type VendorRow = { id: string; phone: string; shop_name: string };

async function seedCustomer(phone: string) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

async function createVendor(tag: string): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `IBV Vendor ${tag}`,
      shop_name: `!IBV-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedAcceptedRequest(
  vendorId: string,
  customerPhone: string,
  message: string,
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: `device_ibv_${T}_${customerPhone}`,
      message,
      status: 'accepted',
      delivery_slot: 'morning',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function insertCashBillViaRpc(opts: {
  requestId: string;
  vendorId: string;
  customerPhone: string;
  total: number;
}) {
  const { data, error } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: opts.requestId,
    p_vendor_id: opts.vendorId,
      p_vendor_phone: await vendorPhoneById(opts.vendorId),
    p_customer_phone: opts.customerPhone,
    p_total: opts.total,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'Test item', quantity: 1, unit_price: opts.total, unit: null }],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  return data as string;
}

async function gotoVendorAndWaitOrders(page: Page) {
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
}

function incomingCard(page: Page, message: string): Locator {
  return page.getByTestId('incoming-order-card').filter({ hasText: message });
}

async function loginVendorAndWaitOrders(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorAndWaitOrders(page);
}

async function cleanupRequestArtifacts(requestId: string) {
  await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
}

async function cleanupVendor(vendorId: string) {
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
}

async function cleanupCustomer(phone: string) {
  await supabaseAdmin.from('users').delete().eq('phone', phone);
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('IBV-01 — no bill yet: Create Bill opens BillSheet', async ({ page }) => {
  const vendor = await createVendor('01');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `IBV-01 accepted ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);

  try {
    await loginVendorAndWaitOrders(page, vendor);
    const card = incomingCard(page, msg);
    const billBtn = card.getByTestId('incoming-bill-btn');

    await expect(billBtn).toHaveText(L.createBill);
    await expect(page.getByTestId('bill-sheet')).toHaveCount(0);

    await billBtn.click();
    await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 10000 });
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});

test('IBV-02 — bill exists: View Bill scrolls preview and does not open BillSheet', async ({
  page,
}) => {
  const vendor = await createVendor('02');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `IBV-02 billed ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);

  await insertCashBillViaRpc({
    requestId: request.id,
    vendorId: vendor.id,
    customerPhone,
    total: 250,
  });

  try {
    await loginVendorAndWaitOrders(page, vendor);
    const card = incomingCard(page, msg);
    const billBtn = card.getByTestId('incoming-bill-btn');
    const preview = card.getByTestId('incoming-bill-preview');

    await expect(billBtn).toHaveText(L.viewBill);
    await expect(preview).toBeVisible();
    await expect(page.getByTestId('bill-sheet')).toHaveCount(0);

    await billBtn.click();

    await expect(page.getByTestId('bill-sheet')).toHaveCount(0);
    await expect(preview).toBeInViewport({ timeout: 10000 });
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});

test('IBV-03 — inline preview shows correct total and unpaid status', async ({ page }) => {
  const vendor = await createVendor('03');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `IBV-03 preview ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);
  const billTotal = 375.5;

  await insertCashBillViaRpc({
    requestId: request.id,
    vendorId: vendor.id,
    customerPhone,
    total: billTotal,
  });

  try {
    await loginVendorAndWaitOrders(page, vendor);
    const card = incomingCard(page, msg);
    const preview = card.getByTestId('incoming-bill-preview');

    await expect(preview).toBeVisible();
    await expect(preview).toContainText(`${L.billTotal}: ₹${billTotal.toFixed(2)}`);
    await expect(preview).toContainText(L.billCash);
    await expect(preview).toContainText(L.billUnpaid);
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});
