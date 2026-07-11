import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_bsc_vendor_${T}`;

const L = {
  createBill: '📋 Create Bill',
  itemNamePlaceholder: 'Item name',
  sendBill: 'Send Bill',
  cancel: 'Cancel',
  confirmSendTitle: 'Send this bill?',
  billSent: 'Bill sent!',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99003${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88003${String(T + customerPhoneSeq).slice(-5)}`;
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
      name: `BSC Vendor ${tag}`,
      shop_name: `!BSC-${tag}-${T}`,
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
      device_id: `device_bsc_${T}_${customerPhone}`,
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

function confirmSendDialog(page: Page): Locator {
  return page.getByRole('alertdialog').filter({ hasText: L.confirmSendTitle });
}

async function openBillSheetForOrder(page: Page, message: string) {
  const card = incomingCard(page, message);
  const billBtn = card.getByTestId('incoming-bill-btn');
  await expect(billBtn).toHaveText(L.createBill);
  await billBtn.click();
  await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 10000 });
}

async function fillOneItemBill(page: Page, description: string, unitPrice: number) {
  await page.getByPlaceholder(L.itemNamePlaceholder).fill(description);
  await page.locator('input[aria-label="Unit price"]').fill(String(unitPrice));
  await expect(page.getByTestId('bill-submit-btn')).toBeEnabled();
}

async function assertNoBillForRequest(requestId: string) {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .select('id')
    .eq('request_id', requestId)
    .neq('payment_status', 'void');
  if (error) throw error;
  expect(data?.length ?? 0).toBe(0);
}

async function assertBillForRequest(requestId: string, expectedTotal: number) {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .select('id, total_amount, payment_mode, payment_status')
    .eq('request_id', requestId)
    .neq('payment_status', 'void')
    .maybeSingle();
  if (error) throw error;
  expect(data).not.toBeNull();
  expect(Number(data!.total_amount)).toBeCloseTo(expectedTotal, 2);
  expect(data!.payment_mode).toBe('cash');
  expect(data!.payment_status).toBe('unpaid');
  return data!;
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

test('BSC-01 — Send opens confirm dialog, does not create bill yet', async ({ page }) => {
  const vendor = await createVendor('01');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `BSC-01 send confirm ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);
  const unitPrice = 199.5;

  try {
    await loginVendorAndWaitOrders(page, vendor);
    await openBillSheetForOrder(page, msg);
    await fillOneItemBill(page, 'BSC-01 item', unitPrice);

    await page.getByTestId('bill-submit-btn').click();

    const dialog = confirmSendDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog.getByRole('heading', { name: L.confirmSendTitle })).toBeVisible();

    await assertNoBillForRequest(request.id);
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});

test('BSC-02 — Cancel on confirm dialog aborts, no bill created, BillSheet stays open', async ({
  page,
}) => {
  const vendor = await createVendor('02');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `BSC-02 cancel abort ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);

  try {
    await loginVendorAndWaitOrders(page, vendor);
    await openBillSheetForOrder(page, msg);
    await fillOneItemBill(page, 'BSC-02 item', 120);

    await page.getByTestId('bill-submit-btn').click();

    const dialog = confirmSendDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: L.cancel }).click();

    await expect(dialog).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('bill-sheet')).toBeVisible();
    await assertNoBillForRequest(request.id);
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});

test('BSC-03 — Confirm on dialog creates the bill', async ({ page }) => {
  const vendor = await createVendor('03');
  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `BSC-03 confirm send ${T}`;
  const request = await seedAcceptedRequest(vendor.id, customerPhone, msg);
  const unitPrice = 275.25;

  try {
    await loginVendorAndWaitOrders(page, vendor);
    await openBillSheetForOrder(page, msg);
    await fillOneItemBill(page, 'BSC-03 item', unitPrice);

    await page.getByTestId('bill-submit-btn').click();

    const dialog = confirmSendDialog(page);
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await dialog.getByRole('button', { name: L.sendBill }).click();

    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('bill-sheet')).not.toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-sonner-toast]').getByText(L.billSent)).toBeVisible({
      timeout: 10000,
    });

    await assertBillForRequest(request.id, unitPrice);
  } finally {
    await cleanupRequestArtifacts(request.id);
    await cleanupVendor(vendor.id);
    await cleanupCustomer(customerPhone);
  }
});
