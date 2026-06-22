import { test, expect } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  cleanupTestData,
  cleanupTestVendors,
  getActiveCategories,
  seedDefaultVendorVerification,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_edit_${TEST_SESSION}`;

function editShopSheet(page: import('@playwright/test').Page) {
  return page.locator('[role="dialog"]').filter({ hasText: 'Edit Shop Details' });
}

async function createEditTestVendor(
  overrides: Record<string, unknown> = {},
  categoryCount = 1,
) {
  const phone = `99005${Date.now().toString().slice(-5)}`;
  const categories = await getActiveCategories(Math.max(categoryCount, 3));
  const primary = categories[0];

  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Edit Test Owner',
      shop_name: `Fresh Grocery Mart ${phone.slice(-4)}`,
      phone,
      category: primary.label,
      service_mode: primary.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      is_manual_verified: false,
      upi_id: 'editvendor@upi',
      vendor_note: `test_session:${TEST_SESSION}`,
      ...overrides,
    })
    .select()
    .single();
  if (error) throw error;

  for (let i = 0; i < categoryCount; i++) {
    await seedVendorCategory(data.id, categories[i], { is_primary: i === 0 });
  }
  await seedDefaultVendorVerification(data.id);

  return { vendor: data, phone, categories };
}

async function openEditShopSheet(page: import('@playwright/test').Page, phone: string, vendorId: string) {
  await loginAsVendor(page, phone, vendorId, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: /Complete your verification/i }).click();
  await page.getByRole('button', { name: /Edit Shop Details/i }).click();
  await expect(page.getByRole('heading', { name: 'Edit Shop Details' })).toBeVisible({ timeout: 8000 });
  await expect(editShopSheet(page).locator('.animate-spin')).not.toBeVisible({ timeout: 8000 });
  await expect(editShopSheet(page).getByText(/\d\/5 selected/)).toBeVisible({ timeout: 8000 });
}

async function ensureCategorySelected(page: import('@playwright/test').Page, label: string) {
  const sheet = editShopSheet(page);
  const chip = sheet.getByRole('button').filter({ hasText: label }).first();
  await expect(chip).toBeVisible({ timeout: 8000 });
  const className = (await chip.getAttribute('class')) ?? '';
  if (!className.includes('ring-primary')) {
    await chip.click();
  }
}

async function saveEditShop(page: import('@playwright/test').Page) {
  const saveBtn = editShopSheet(page).getByRole('button', { name: 'Save' });
  await expect(saveBtn).toBeEnabled({ timeout: 10000 });
  await saveBtn.click();
  await page.waitForTimeout(2000);
}

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('VE-01: vendor can change vendor_type from shop to home and save', async ({ page }) => {
  const { vendor, phone } = await createEditTestVendor({ vendor_type: 'shop' });
  await openEditShopSheet(page, phone, vendor.id);

  await page.getByRole('button', { name: /Home/i }).filter({ hasText: /work from home/i }).first().click();
  await saveEditShop(page);

  const { data } = await supabaseAdmin.from('vendors').select('vendor_type').eq('id', vendor.id).single();
  expect(data?.vendor_type).toBe('home');
});

test('VE-02: vendor can add a second category in edit sheet', async ({ page }) => {
  const { vendor, phone, categories } = await createEditTestVendor({ vendor_type: 'shop' }, 1);
  const secondCategory = categories[1];

  await openEditShopSheet(page, phone, vendor.id);
  await ensureCategorySelected(page, secondCategory.label);
  await saveEditShop(page);

  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendor.id);
  expect(vcRows?.length).toBe(2);
});

test('VE-03: selecting 3+ categories sets needs_review on vendor_categories rows', async ({ page }) => {
  const categories = await getActiveCategories(3);
  expect(categories.length).toBeGreaterThanOrEqual(3);

  const { vendor, phone } = await createEditTestVendor({ vendor_type: 'shop' }, 1);
  await openEditShopSheet(page, phone, vendor.id);

  await ensureCategorySelected(page, categories[1].label);
  await ensureCategorySelected(page, categories[2].label);
  await saveEditShop(page);

  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('needs_review')
    .eq('vendor_id', vendor.id);
  expect(vcRows?.length).toBeGreaterThanOrEqual(3);
  expect(vcRows?.every((row) => row.needs_review === true)).toBe(true);
});
