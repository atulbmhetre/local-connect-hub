import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsVendor, loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_kcd_${T}`;

const L = {
  refundDuePrefix: 'Refund due: ₹',
  refundDueLabel: 'Refund due',
  myTabs: 'My Dues',
  emptyLedger: 'No outstanding amounts',
} as const;

const CREDIT_AMOUNT = 70;

const createdVendorIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99011${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88011${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

type VendorRow = { id: string; phone: string; shop_name: string };

async function createVendor(tag: string): Promise<VendorRow> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const shopName = `!KCD-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `KCD Vendor ${tag}`,
      shop_name: shopName,
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

async function seedCustomer(phone: string) {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
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

async function expectBlueRefundBalance(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toHaveClass(/text-blue-400/);
  const rgb = await locator.evaluate((el) => window.getComputedStyle(el).color);
  expect(rgb).toMatch(/rgb\(\s*96,\s*165,\s*250\s*\)/);
}

function refundDueText(amount: number): string {
  return `${L.refundDuePrefix}${amount.toFixed(2)}`;
}

async function openLedgerCustomerRow(page: Page, label: string) {
  const row = page.getByRole('button').filter({ hasText: label });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
}

test.afterAll(async () => {
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('khata_transactions').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('khata_ledger').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('KB-KCD-01 — negative khata credit: blue Refund due label on vendor ledger and customer My Tabs', async ({
  page,
}) => {
  const vendor = await createVendor('display');
  const creditCustomer = nextCustomerPhone();
  const settledCustomer = nextCustomerPhone();
  await seedCustomer(creditCustomer);
  await seedKhataLedger(vendor.id, creditCustomer, -CREDIT_AMOUNT);
  await seedKhataLedger(vendor.id, settledCustomer, 0);

  const refundLabel = refundDueText(CREDIT_AMOUNT);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });

  await expect(page.getByText(refundLabel)).toBeVisible();
  await expect(page.getByText('₹0.00')).not.toBeVisible();
  await expectBlueRefundBalance(page.getByText(refundLabel));

  await openLedgerCustomerRow(page, refundLabel);
  const ledgerBalance = page.getByTestId('ledger-balance');
  await expect(ledgerBalance).toHaveText(refundLabel);
  await expectBlueRefundBalance(ledgerBalance);

  await page.getByRole('button', { name: 'Close' }).click().catch(() => undefined);
  await page.keyboard.press('Escape');

  const customerDeviceId = `device_kcd_cust_${T}`;
  await loginAsCustomer(page, creditCustomer, customerDeviceId);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  await expect(page.getByText(L.myTabs)).toBeVisible();
  const myTabRow = page.getByRole('button').filter({ hasText: vendor.shop_name });
  await expect(myTabRow).toBeVisible();
  await expect(myTabRow.getByText(refundLabel)).toBeVisible();
  await expectBlueRefundBalance(myTabRow.getByText(refundLabel));

  await myTabRow.click();
  await expect(page.getByRole('heading', { name: vendor.shop_name })).toBeVisible();
  await expect(page.getByText(L.refundDueLabel, { exact: true })).toBeVisible();
  const detailAmount = page.locator('.border-t.border-surface-border').getByText(`₹${CREDIT_AMOUNT.toFixed(2)}`);
  await expect(detailAmount).toBeVisible();
  await expectBlueRefundBalance(detailAmount);
});
