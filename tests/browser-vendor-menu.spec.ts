import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorMyBusinessTab, expandFirstMyBusinessCategoryAccordion, APP_URL } from './helpers/browser-setup';
import { supabaseAdmin, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
let testVendor: any;

async function openMenuSection(page: any) {
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);
  const menuCollapsible = page.getByRole('button', { name: /my menu/i }).first();
  await expect(menuCollapsible).toBeVisible({ timeout: 8000 });
  if ((await menuCollapsible.getAttribute('aria-expanded')) !== 'true') {
    await menuCollapsible.click();
  }
  await page.waitForTimeout(500);
}

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('MENU-01: menu section visible for vendor in My Business tab', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);

  await expect(page.getByRole('button', { name: /my menu/i }).first()).toBeVisible({ timeout: 8000 });
});

test('MENU-02: Add Item button visible in MY SHOP menu section', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await openMenuSection(page);
  const addBtn = page.getByRole('button', { name: /add item|add menu|new item/i }).first();
  await expect(addBtn).toBeVisible({ timeout: 8000 });
});

test('MENU-03: add menu item — inserts row in vendor_menu_items', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await openMenuSection(page);

  const addBtn = page.getByRole('button', { name: '+ Add Item' }).first();
  await expect(addBtn).toBeVisible({ timeout: 8000 });
  await addBtn.click();

  // Inline form appears — fill name and price
  const nameInput = page.getByPlaceholder('Item name').first();
  await expect(nameInput).toBeVisible({ timeout: 5000 });
  await nameInput.fill(`Test Item ${TEST_SESSION}`);

  const priceInput = page.getByPlaceholder('Price (₹)').first();
  await expect(priceInput).toBeVisible({ timeout: 3000 });
  await priceInput.fill('50');

  // Save within My Business operations (not the profile Save at top of tab).
  const saveBtn = page.getByTestId('my-business-operations').getByRole('button', { name: 'Save' });
  await expect(saveBtn).toBeVisible({ timeout: 3000 });
  await saveBtn.click();
  await page.waitForTimeout(2000);

  const { data } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id, name')
    .eq('vendor_id', testVendor.id)
    .like('name', `%${TEST_SESSION}%`);
  expect(data?.length).toBeGreaterThan(0);
});

test('MENU-04: add menu item directly to DB — row readable', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendor_menu_items')
    .insert({
      vendor_id: testVendor.id,
      name: `DB Menu Item ${TEST_SESSION}`,
      price: 120,
      unit: 'kg',
      is_available: true,
      sort_order: 1,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.name).toContain('DB Menu Item');
  expect(data.is_available).toBe(true);
});

test('MENU-05: delete menu item — row removed from DB', async () => {
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .insert({
      vendor_id: testVendor.id,
      name: `Delete Me ${TEST_SESSION}`,
      price: 10,
      unit: 'pc',
    })
    .select()
    .single();

  await supabaseAdmin
    .from('vendor_menu_items')
    .delete()
    .eq('id', item.id);

  const { data } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('id', item.id);

  expect(data?.length).toBe(0);
});

test('MENU-06: edit menu item — price updated in DB', async () => {
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .insert({
      vendor_id: testVendor.id,
      name: `Edit Me ${TEST_SESSION}`,
      price: 100,
      unit: 'pc',
    })
    .select()
    .single();

  await supabaseAdmin
    .from('vendor_menu_items')
    .update({ price: 150 })
    .eq('id', item.id);

  const { data } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('price')
    .eq('id', item.id)
    .single();

  expect(data?.price).toBe(150);
});

test('MENU-07: menu item is_available toggle works', async () => {
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .insert({
      vendor_id: testVendor.id,
      name: `Toggle Me ${TEST_SESSION}`,
      price: 80,
      unit: 'pc',
      is_available: true,
    })
    .select()
    .single();

  await supabaseAdmin
    .from('vendor_menu_items')
    .update({ is_available: false })
    .eq('id', item.id);

  const { data } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('is_available')
    .eq('id', item.id)
    .single();

  expect(data?.is_available).toBe(false);
});

test('MENU-08: multiple menu items for vendor — all returned', async () => {
  // Insert 3 items
  await supabaseAdmin.from('vendor_menu_items').insert([
    { vendor_id: testVendor.id, name: `Bulk A ${TEST_SESSION}`, price: 10, unit: 'pc' },
    { vendor_id: testVendor.id, name: `Bulk B ${TEST_SESSION}`, price: 20, unit: 'kg' },
    { vendor_id: testVendor.id, name: `Bulk C ${TEST_SESSION}`, price: 30, unit: 'hr' },
  ]);

  const { data } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', testVendor.id);

  expect(data?.length).toBeGreaterThanOrEqual(3);
});
