import { test, expect } from '@playwright/test';
import { APP_URL, prepareAndCompleteOtp } from './helpers/browser-setup';
import {
  cleanupTestData,
  cleanupTestVendors,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  supabaseAdmin,
  TEST_SESSION,
} from './helpers/setup';
import {
  cleanupBrowserSession38Data,
  uniqueBrowserPhone,
} from './helpers/session38';
import { openPhoneEntrySheet, submitPhoneNumber } from './helpers/browser-recovery';
import { strings } from '../src/lib/strings';

const TEST_DEVICE_ID = `device_reco_${TEST_SESSION}`;
const FRESH_PHONE = uniqueBrowserPhone('8801');
const EXISTING_PHONE = uniqueBrowserPhone('8802');
const EN = strings.en;
const T = Date.now();

test.describe.configure({ timeout: 180_000 });

let testVendor: { id: string; shop_name: string };

/** Welcomed customer with no phone — matches post–"Use as customer" browsing. */
async function loginAsBrowsingCustomer(page: import('@playwright/test').Page) {
  // Avoid loginAsFreshUser: its addInitScript clears storage on every navigation.
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, TEST_DEVICE_ID);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible();
}

test.beforeAll(async () => {
  // Same seed pattern as FO-REQ / RA-01 — huge radius + customer-place reach.
  const category = await getActiveCategoryByServiceMode('delivery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'RECOV Vendor',
      shop_name: `!RECOV-${T}`,
      phone: uniqueBrowserPhone('9908'),
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor!.id, category, {
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
  });
  testVendor = vendor!;
});

test.afterEach(async () => {
  await cleanupBrowserSession38Data([FRESH_PHONE, EXISTING_PHONE], [TEST_DEVICE_ID]);
});

test.afterAll(async () => {
  if (testVendor?.id) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', testVendor.id);
    await supabaseAdmin.from('vendors').delete().eq('id', testVendor.id);
  }
  await cleanupTestVendors();
  await cleanupTestData();
});

test('RECOV-01: fresh user with no order history skips existing-account offer', async ({ page }) => {
  await loginAsBrowsingCustomer(page);

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await submitPhoneNumber(page, FRESH_PHONE);

  await expect(page.getByTestId('phone-entry-existing-title')).not.toBeVisible({ timeout: 3000 });

  const savedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(savedPhone).toBe(FRESH_PHONE);
});

test('RECOV-02: known phone under new-path customer offers restore safety net', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({
    phone: EXISTING_PHONE,
    total_orders: 4,
    completed_orders: 2,
  });

  await loginAsBrowsingCustomer(page);

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await submitPhoneNumber(page, EXISTING_PHONE);

  await expect(page.getByTestId('phone-entry-existing-title')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('phone-entry-existing-title')).toHaveText(
    EN.firstopen_existing_title,
  );
  await expect(page.getByTestId('phone-entry-existing-restore')).toBeVisible();
  await expect(page.getByTestId('phone-entry-existing-continue')).toHaveText(
    EN.firstopen_existing_continue,
  );

  // Before choosing, phone must not be silently saved as a fresh identity.
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  await prepareAndCompleteOtp(page, EXISTING_PHONE, () =>
    page.getByTestId('phone-entry-existing-continue').click(),
  );
  const savedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(savedPhone).toBe(EXISTING_PHONE);
});

test('RECOV-03: restore from safety net proceeds with order', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({
    phone: EXISTING_PHONE,
    total_orders: 2,
    completed_orders: 1,
  });

  await loginAsBrowsingCustomer(page);

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await submitPhoneNumber(page, EXISTING_PHONE);

  await expect(page.getByTestId('phone-entry-existing-title')).toBeVisible({ timeout: 10000 });
  await prepareAndCompleteOtp(page, EXISTING_PHONE, () =>
    page.getByTestId('phone-entry-existing-restore').click(),
  );

  const savedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(savedPhone).toBe(EXISTING_PHONE);

  await expect(page.getByTestId('parchi-sheet')).not.toBeVisible({ timeout: 15000 });

  const { data: orders } = await supabaseAdmin
    .from('requests')
    .select('id, user_phone, message')
    .eq('device_id', TEST_DEVICE_ID)
    .eq('user_phone', EXISTING_PHONE)
    .order('created_at', { ascending: false })
    .limit(1);

  expect(orders?.length).toBeGreaterThan(0);
  expect(orders![0].message).toContain('Browser recovery test order');
});
