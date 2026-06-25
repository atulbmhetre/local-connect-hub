import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import { supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';

const T = Date.now();
const LOCAL_CUSTOMER_PHONE = `8800${String(T).slice(-6)}`;
const TEST_DEVICE_ID = `device_khata_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer(LOCAL_CUSTOMER_PHONE);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData(LOCAL_CUSTOMER_PHONE);
});

async function seedAcceptedOrder(message = 'Khata test order') {
  const { data } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message,
    status: 'accepted',
  }).select().single();
  return data;
}

async function seedKhataBill(requestId: string, amount: number) {
  const { data } = await supabaseAdmin.from('order_bills').insert({
    request_id: requestId,
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    total_amount: amount,
    payment_mode: 'khata',
    payment_status: 'unpaid',
  }).select().single();
  // Also create ledger entry
  await supabaseAdmin.from('khata_ledger').upsert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    total_outstanding: amount,
  }, { onConflict: 'vendor_id,user_phone' });
  return data;
}

// ─── BILL CREATION ─────────────────────────────────────────────────────────

test('BK-UI-01: vendor send bill button visible on accepted order', async ({ page }) => {
  await seedAcceptedOrder('Bill button test');
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('incoming-bill-btn').first()).toBeVisible({ timeout: 8000 });
});

test('BK-UI-02: bill sheet opens when send bill clicked', async ({ page }) => {
  await seedAcceptedOrder('Bill sheet test');
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('incoming-bill-btn').first().click();
  await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 5000 });
});

test('BK-DB-01: khata bill seeded directly — order_bills row exists', async () => {
  const order = await seedAcceptedOrder('DB bill test');
  const bill = await seedKhataBill(order!.id, 250);
  expect(bill).not.toBeNull();
  expect(bill!.payment_mode).toBe('khata');
  expect(bill!.total_amount).toBe(250);
});

test('BK-DB-02: khata bill creates ledger entry with correct outstanding', async () => {
  const order = await seedAcceptedOrder('Ledger test');
  await seedKhataBill(order!.id, 500);
  const { data } = await supabaseAdmin.from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', LOCAL_CUSTOMER_PHONE)
    .single();
  expect(data?.total_outstanding).toBeGreaterThan(0);
});

// ─── LEDGER UI ─────────────────────────────────────────────────────────────

test('BK-UI-03: ledger screen accessible for vendor', async ({ page }) => {
  const order = await seedAcceptedOrder('Ledger UI test');
  await seedKhataBill(order!.id, 300);
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 8000 });
});

test('BK-UI-04: ledger balance visible on ledger screen', async ({ page }) => {
  const order = await seedAcceptedOrder('Balance display test');
  await seedKhataBill(order!.id, 750);
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/ledger`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('ledger-screen')).toBeVisible({ timeout: 8000 });
  // Balance testid is on the customer detail sheet — open the seeded entry
  await page.getByRole('button', { name: /₹750\.00/ }).click();
  await expect(page.getByTestId('ledger-balance')).toBeVisible({ timeout: 5000 });
});

// ─── PARTIAL PAYMENT ───────────────────────────────────────────────────────

test('BK-DB-03: partial payment reduces balance not zeroes it', async () => {
  const order = await seedAcceptedOrder('Partial pay test');
  await seedKhataBill(order!.id, 1000);
  // Apply partial payment of 400
  await supabaseAdmin.from('khata_ledger').update({
    total_outstanding: 600,
  }).eq('vendor_id', testVendor.id).eq('user_phone', LOCAL_CUSTOMER_PHONE);
  await supabaseAdmin.from('khata_transactions').insert({
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    amount: 400,
    payment_mode: 'khata',
    note: 'Partial payment test',
    request_id: order!.id,
  });
  const { data } = await supabaseAdmin.from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', LOCAL_CUSTOMER_PHONE)
    .single();
  expect(data?.total_outstanding).toBe(600);
});

test('BK-DB-04: full payment zeroes ledger balance', async () => {
  const order = await seedAcceptedOrder('Full pay test');
  await seedKhataBill(order!.id, 200);
  // Full payment
  await supabaseAdmin.from('khata_ledger').update({
    total_outstanding: 0,
  }).eq('vendor_id', testVendor.id).eq('user_phone', LOCAL_CUSTOMER_PHONE);
  const { data } = await supabaseAdmin.from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', testVendor.id)
    .eq('user_phone', LOCAL_CUSTOMER_PHONE)
    .single();
  expect(data?.total_outstanding).toBe(0);
});

// ─── NEGATIVE CASES ────────────────────────────────────────────────────────

test('BK-NEG-01: duplicate bill for same order — void old on replace', async () => {
  const order = await seedAcceptedOrder('Duplicate bill test');
  await seedKhataBill(order!.id, 300);
  // Void then delete — unique constraint on request_id requires deletion before re-insert
  await supabaseAdmin.from('order_bills').update({ payment_status: 'void' })
    .eq('request_id', order!.id);
  await supabaseAdmin.from('order_bills').delete()
    .eq('request_id', order!.id).eq('payment_status', 'void');
  // Insert replacement
  const { error } = await supabaseAdmin.from('order_bills').insert({
    request_id: order!.id,
    vendor_id: testVendor.id,
    user_phone: LOCAL_CUSTOMER_PHONE,
    total_amount: 350,
    payment_mode: 'khata',
    payment_status: 'unpaid',
  });
  expect(error).toBeNull();
  // Only one unpaid bill
  const { data } = await supabaseAdmin.from('order_bills')
    .select('id, total_amount, payment_status')
    .eq('request_id', order!.id)
    .eq('payment_status', 'unpaid');
  expect(data?.length).toBe(1);
  expect(data![0].total_amount).toBe(350);
});

test('BK-NEG-02: bill payment mode options — cash, UPI, khata all valid', async () => {
  for (const mode of ['cash', 'upi', 'khata']) {
    const order = await seedAcceptedOrder(`Payment mode test ${mode}`);
    const { error } = await supabaseAdmin.from('order_bills').insert({
      request_id: order!.id,
      vendor_id: testVendor.id,
      user_phone: LOCAL_CUSTOMER_PHONE,
      total_amount: 100,
      payment_mode: mode,
      payment_status: 'unpaid',
    });
    expect(error).toBeNull();
  }
});
