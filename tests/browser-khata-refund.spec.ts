import { test, expect, Page } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_krf_${T}`;

const L = {
  recordRefund: 'Record Refund',
  markPaid: 'Mark Paid',
  saveRefund: 'Save Refund',
  refundSaved: 'Refund recorded',
  refundDuePrefix: 'Refund due: ₹',
  creditOwed: 'Credit owed: ₹',
  errInvalidAmount: 'Enter a valid refund amount.',
  errAmountExceedsCredit: 'Refund amount exceeds the credit owed.',
} as const;

const CREDIT_AMOUNT = 70;

const createdVendorIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99012${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88012${String(T + customerPhoneSeq).slice(-5)}`;
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
      name: `KRF Vendor ${tag}`,
      shop_name: `!KRF-${tag}-${T}`,
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

function refundDueText(amount: number): string {
  return `${L.refundDuePrefix}${amount.toFixed(2)}`;
}

async function openLedgerByBalanceLabel(page: Page, label: string) {
  const row = page.getByRole('button').filter({ hasText: label });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(page.getByTestId('ledger-balance')).toBeVisible();
}

async function gotoLedger(page: Page) {
  await page.goto(`${APP_URL}/ledger`);
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 15000 });
}

test.afterAll(async () => {
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

test('KB-KRF-01 — Record Refund visible for negative balance; Mark Paid for positive only', async ({
  page,
}) => {
  const vendor = await createVendor('buttons');
  const creditCustomer = nextCustomerPhone();
  const debtCustomer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, creditCustomer, -CREDIT_AMOUNT);
  await seedKhataLedger(vendor.id, debtCustomer, 150);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoLedger(page);

  await openLedgerByBalanceLabel(page, refundDueText(CREDIT_AMOUNT));
  await expect(page.getByTestId('ledger-record-refund-btn')).toBeVisible();
  await expect(page.getByTestId('ledger-mark-paid-btn')).not.toBeVisible();
  await page.keyboard.press('Escape');

  await openLedgerByBalanceLabel(page, '₹150.00');
  await expect(page.getByTestId('ledger-mark-paid-btn')).toBeVisible();
  await expect(page.getByTestId('ledger-record-refund-btn')).not.toBeVisible();
});

test('KB-KRF-02 — refund amount validated client-side; success updates on-screen balance', async ({
  page,
}) => {
  const vendor = await createVendor('refund-flow');
  const customer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customer, -CREDIT_AMOUNT);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoLedger(page);
  await openLedgerByBalanceLabel(page, refundDueText(CREDIT_AMOUNT));

  await page.getByTestId('ledger-record-refund-btn').click();
  await expect(page.getByText(L.recordRefund).first()).toBeVisible();
  const amountInput = page.getByTestId('ledger-partial-input');
  await expect(amountInput).toHaveValue(String(CREDIT_AMOUNT.toFixed(2)));
  await expect(page.getByText(`${L.creditOwed}${CREDIT_AMOUNT.toFixed(2)}`)).toBeVisible();

  await amountInput.fill('80');
  const saveBtn = page.getByRole('button', { name: L.saveRefund });
  await expect(saveBtn).toBeDisabled();

  await amountInput.fill('0');
  await expect(saveBtn).toBeDisabled();

  await amountInput.fill('40');
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.refundSaved)).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByTestId('ledger-partial-input')).not.toBeVisible({ timeout: 5000 });

  await expect(page.getByTestId('ledger-balance')).toHaveText(refundDueText(30));
  await page.keyboard.press('Escape');

  await expect(page.getByText(refundDueText(30))).toBeVisible();
  await expect(page.getByText(refundDueText(CREDIT_AMOUNT))).not.toBeVisible();
});

test('KB-KRF-03 — full refund clears credit from ledger list', async ({ page }) => {
  const vendor = await createVendor('refund-zero');
  const customer = nextCustomerPhone();
  await seedKhataLedger(vendor.id, customer, -CREDIT_AMOUNT);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoLedger(page);
  await openLedgerByBalanceLabel(page, refundDueText(CREDIT_AMOUNT));

  await page.getByTestId('ledger-record-refund-btn').click();
  await page.getByTestId('ledger-partial-input').fill(String(CREDIT_AMOUNT.toFixed(2)));
  await page.getByRole('button', { name: L.saveRefund }).click();

  await expect(page.locator('[data-sonner-toast]').getByText(L.refundSaved)).toBeVisible({
    timeout: 10000,
  });
  await page.keyboard.press('Escape');

  await expect(page.getByText(refundDueText(CREDIT_AMOUNT))).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByText('No outstanding amounts')).toBeVisible();
});
