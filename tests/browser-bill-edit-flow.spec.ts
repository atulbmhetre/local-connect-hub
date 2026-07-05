import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_be_${T}`;

const L = {
  editBill: 'Edit Bill',
  saveChanges: 'Save changes',
  billUpdated: 'Bill updated',
  reasonValidation: 'Please enter a reason for this correction.',
  lateTitle: 'Edit an older bill?',
  lateBody:
    'This bill is over a day old and was already paid or synced to khata. Editing it will adjust records. Continue?',
  creditTitle: 'Customer will be owed money',
  editedBadge: 'Edited',
  historyTitle: 'Bill edit history',
  cancel: 'Cancel',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdBillIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99013${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88013${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

type VendorRow = { id: string; phone: string; shop_name: string };

async function createVendor(tag: string): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `BE Vendor ${tag}`,
      shop_name: `!BE-${tag}-${T}`,
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
  return vendor as VendorRow;
}

async function seedFulfilledRequest(vendorId: string, customerPhone: string, message: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: `device_be_${T}_${customerPhone}`,
      message,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id;
}

async function insertBill(opts: {
  requestId: string;
  vendorId: string;
  customerPhone: string;
  total: number;
  paymentMode: 'cash' | 'upi' | 'khata';
  paymentStatus?: string;
  itemName?: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: opts.requestId,
    p_vendor_id: opts.vendorId,
    p_customer_phone: opts.customerPhone,
    p_total: opts.total,
    p_payment_mode: opts.paymentMode,
    p_payment_status: opts.paymentStatus ?? 'unpaid',
    p_notes: null,
    p_items: [
      {
        name: opts.itemName ?? 'Test item',
        quantity: 1,
        unit_price: opts.total,
        unit: null,
      },
    ],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  createdBillIds.push(data as string);
  return data as string;
}

async function loginVendorAndWaitOrders(page: Page, vendor: VendorRow) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 20000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('incoming-order-card').filter({ hasText: message });
}

async function openEditBillSheet(page: Page, message: string) {
  const card = orderCard(page, message);
  await card.getByTestId('incoming-edit-bill-btn').click();
  await expect(page.getByTestId('bill-edit-sheet')).toBeVisible({ timeout: 10000 });
}

async function setFirstLineUnitPrice(page: Page, price: number) {
  await page.locator('input[aria-label="Unit price"]').first().fill(String(price));
}

test.afterAll(async () => {
  if (createdBillIds.length) {
    await supabaseAdmin.from('bill_edit_audit').delete().in('bill_id', createdBillIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('khata_transactions').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('khata_transactions').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('khata_ledger').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('BE-UI-01 — fresh unpaid bill edits without reason; no dialog', async ({ page }) => {
  const vendor = await createVendor('unpaid');
  const customer = nextCustomerPhone();
  const message = `BE-UI-01-${T}`;
  const requestId = await seedFulfilledRequest(vendor.id, customer, message);
  await insertBill({
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total: 200,
    paymentMode: 'cash',
  });

  await loginVendorAndWaitOrders(page, vendor);
  await openEditBillSheet(page, message);
  await setFirstLineUnitPrice(page, 150);
  await page.getByTestId('bill-edit-save-btn').click();

  await expect(page.getByRole('alertdialog')).not.toBeVisible();
  await expect(page.locator('[data-sonner-toast]').getByText(L.billUpdated)).toBeVisible({
    timeout: 10000,
  });
  await expect(orderCard(page, message).getByText('₹150.00')).toBeVisible();
});

test('BE-UI-02 — paid bill blocks save with inline reason validation (no RPC)', async ({ page }) => {
  const vendor = await createVendor('paid-reason');
  const customer = nextCustomerPhone();
  const message = `BE-UI-02-${T}`;
  const requestId = await seedFulfilledRequest(vendor.id, customer, message);
  const billId = await insertBill({
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total: 300,
    paymentMode: 'cash',
  });

  const { error: markPaidError } = await supabase.rpc('vendor_mark_bill_paid', {
    p_bill_id: billId,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(markPaidError).toBeNull();

  let rpcCalled = false;
  await page.route('**/rest/v1/rpc/vendor_edit_bill', (route) => {
    rpcCalled = true;
    void route.continue();
  });

  await loginVendorAndWaitOrders(page, vendor);
  await openEditBillSheet(page, message);
  await setFirstLineUnitPrice(page, 250);
  await page.locator('#bill-edit-reason').fill('');
  await page.getByTestId('bill-edit-save-btn').click();

  await expect(page.getByText(L.reasonValidation)).toBeVisible();
  await expect(page.locator('[data-sonner-toast]').getByText(L.billUpdated)).not.toBeVisible();
  expect(rpcCalled).toBe(false);
});

test('BE-UI-03 — backdated paid bill shows late-edit dialog then succeeds on confirm', async ({
  page,
}) => {
  const vendor = await createVendor('late');
  const customer = nextCustomerPhone();
  const message = `BE-UI-03-${T}`;
  const requestId = await seedFulfilledRequest(vendor.id, customer, message);
  const billId = await insertBill({
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total: 400,
    paymentMode: 'cash',
  });

  await supabase.rpc('vendor_mark_bill_paid', {
    p_bill_id: billId,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });

  const backdate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  await supabaseAdmin.from('order_bills').update({ created_at: backdate }).eq('id', billId);

  await loginVendorAndWaitOrders(page, vendor);
  await openEditBillSheet(page, message);
  await setFirstLineUnitPrice(page, 350);
  await page.locator('#bill-edit-reason').fill('Late price correction');
  await page.getByTestId('bill-edit-save-btn').click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(L.lateTitle)).toBeVisible();
  await expect(dialog.getByText(L.lateBody)).toBeVisible();
  await dialog.getByRole('button', { name: L.saveChanges }).click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.billUpdated)).toBeVisible({
    timeout: 10000,
  });
  await expect(orderCard(page, message).getByText('₹350.00')).toBeVisible();
});

test('BE-UI-04 — khata over-correction shows credit dialog with amount; confirm succeeds', async ({
  page,
}) => {
  const vendor = await createVendor('credit');
  const customer = nextCustomerPhone();
  const message = `BE-UI-04-${T}`;
  const requestId = await seedFulfilledRequest(vendor.id, customer, message);
  const billId = await insertBill({
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total: 100,
    paymentMode: 'khata',
  });

  await supabase.rpc('vendor_record_khata_payment', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_customer_phone: customer,
    p_amount: 80,
    p_note: 'Partial before edit',
  });

  await loginVendorAndWaitOrders(page, vendor);
  await openEditBillSheet(page, message);
  await setFirstLineUnitPrice(page, 10);
  await page.locator('#bill-edit-reason').fill('Over-correction in UI test');
  await page.getByTestId('bill-edit-save-btn').click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByText(L.creditTitle)).toBeVisible();
  await expect(dialog.getByText('₹70.00')).toBeVisible();
  await dialog.getByRole('button', { name: L.saveChanges }).click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.billUpdated)).toBeVisible({
    timeout: 10000,
  });

  const { data: ledger } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', vendor.id)
    .eq('user_phone', customer)
    .single();
  expect(ledger?.total_outstanding).toBe(-70);
});

test('BE-UI-05 — Edited badge opens history with old→new total and reason', async ({ page }) => {
  const vendor = await createVendor('history');
  const customer = nextCustomerPhone();
  const message = `BE-UI-05-${T}`;
  const reason = 'Correction for history test';
  const requestId = await seedFulfilledRequest(vendor.id, customer, message);
  await insertBill({
    requestId,
    vendorId: vendor.id,
    customerPhone: customer,
    total: 120,
    paymentMode: 'cash',
  });

  await loginVendorAndWaitOrders(page, vendor);
  await openEditBillSheet(page, message);
  await setFirstLineUnitPrice(page, 95);
  await page.locator('#bill-edit-reason').fill(reason);
  await page.getByTestId('bill-edit-save-btn').click();
  await expect(page.locator('[data-sonner-toast]').getByText(L.billUpdated)).toBeVisible({
    timeout: 10000,
  });

  const badge = orderCard(page, message).getByTestId('incoming-bill-edited-badge');
  await expect(badge).toHaveText(L.editedBadge);
  await badge.click();

  await expect(page.getByText(L.historyTitle)).toBeVisible();
  await expect(page.getByText('₹120.00 → ₹95.00')).toBeVisible();
  await expect(page.getByText(reason)).toBeVisible();
});
