import { test, expect } from '@playwright/test';
import { loginAsFreshUser } from './helpers/browser-setup';
import {
  createTestVendor,
  cleanupTestData, cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';
import {
  cleanupBrowserSession38Data,
  supabaseAdmin,
  uniqueBrowserPhone,
} from './helpers/session38';
import { openPhoneEntrySheet, submitPhoneNumber } from './helpers/browser-recovery';
import { mintBrowserSupabaseSession } from './helpers/setup';

const TEST_DEVICE_ID = `device_reco_${TEST_SESSION}`;
const FRESH_PHONE = uniqueBrowserPhone('8801');
const EXISTING_PHONE = uniqueBrowserPhone('8802');

let testVendor: { id: string; shop_name: string };

test.beforeAll(async () => {
  // Delivery empty-browse requires customer-place reach (same as SLOT-01 / RA-01).
  testVendor = await createTestVendor({
    service_mode: 'delivery',
    serves_at_customer_place: true,
    is_active: true,
  });
  await supabaseAdmin
    .from('vendors')
    .update({ serves_at_customer_place: true, service_mode: 'delivery', is_active: true })
    .eq('id', testVendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ serves_at_customer_place: true })
    .eq('vendor_id', testVendor.id);
});

test.afterEach(async () => {
  await cleanupBrowserSession38Data([FRESH_PHONE, EXISTING_PHONE], [TEST_DEVICE_ID]);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('RECOV-01: fresh user with no order history skips welcome back screen', async ({ page }) => {
  await loginAsFreshUser(page);
  await page.evaluate(({ deviceId }) => {
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { deviceId: TEST_DEVICE_ID });

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await submitPhoneNumber(page, FRESH_PHONE);

  await expect(page.getByText('Welcome back!')).not.toBeVisible({ timeout: 3000 });

  const savedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(savedPhone).toBe(FRESH_PHONE);
});

test('RECOV-02: returning user with orders skips welcome back during parchi order flow', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({
    phone: EXISTING_PHONE,
    total_orders: 4,
    completed_orders: 2,
  });

  await loginAsFreshUser(page);
  await page.evaluate(({ deviceId }) => {
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { deviceId: TEST_DEVICE_ID });

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await submitPhoneNumber(page, EXISTING_PHONE);

  await expect(page.getByText('Welcome back!')).not.toBeVisible({ timeout: 3000 });
  const savedPhone = await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'));
  expect(savedPhone).toBe(EXISTING_PHONE);
});

test('RECOV-03: returning user phone saved and order proceeds without recovery screen', async ({ page }) => {
  await supabaseAdmin.from('users').upsert({
    phone: EXISTING_PHONE,
    total_orders: 2,
    completed_orders: 1,
  });

  await loginAsFreshUser(page);
  await page.evaluate(({ deviceId }) => {
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { deviceId: TEST_DEVICE_ID });

  await openPhoneEntrySheet(page, {
    shopName: testVendor.shop_name,
    vendorId: testVendor.id,
    deviceId: TEST_DEVICE_ID,
  });
  await mintBrowserSupabaseSession(page, EXISTING_PHONE, 'RECOV-03');
  await submitPhoneNumber(page, EXISTING_PHONE);

  await expect(page.getByText('Welcome back!')).not.toBeVisible({ timeout: 3000 });

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
