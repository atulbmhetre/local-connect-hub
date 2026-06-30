import { test, expect } from '@playwright/test';
import { loginAsVendor, loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  cleanupTestData,
  cleanupTestVendors,
  getActiveCategories,
  getActiveCategoryByLabel,
  seedDefaultVendorVerification,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_edit_${TEST_SESSION}`;
const RADAR_CUSTOMER_DEVICE = `device_mcv_remove_${TEST_SESSION}`;

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

async function ensureCategorySelected(page: import('@playwright/test').Page, categoryId: string) {
  const sheet = editShopSheet(page);
  const chip = sheet.getByTestId(`vendor-edit-category-${categoryId}`);
  await expect(chip).toBeVisible({ timeout: 8000 });
  const className = (await chip.getAttribute('class')) ?? '';
  if (!className.includes('ring-primary')) {
    await chip.click();
  }
}

async function deselectCategory(page: import('@playwright/test').Page, categoryId: string) {
  const sheet = editShopSheet(page);
  const chip = sheet.getByTestId(`vendor-edit-category-${categoryId}`);
  await expect(chip).toBeVisible({ timeout: 8000 });
  const className = (await chip.getAttribute('class')) ?? '';
  if (className.includes('ring-primary')) {
    await chip.click();
  }
  await expect(sheet.getByText(/1\/5 selected/)).toBeVisible({ timeout: 5000 });
}

async function expectRadarVendorForCategory(
  page: import('@playwright/test').Page,
  customerPhone: string,
  shopName: string,
  categoryLabel: string,
  shouldAppear: boolean,
) {
  await loginAsCustomer(page, customerPhone, RADAR_CUSTOMER_DEVICE);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(
    `${APP_URL}/radar?mode=help&q=${encodeURIComponent(categoryLabel)}`,
  );
  await page.waitForLoadState('networkidle');

  const card = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
  if (shouldAppear) {
    await expect(card).toBeVisible({ timeout: 15000 });
  } else {
    await expect(card).not.toBeVisible({ timeout: 8000 });
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
  await ensureCategorySelected(page, secondCategory.id);
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

  await ensureCategorySelected(page, categories[1].id);
  await ensureCategorySelected(page, categories[2].id);
  await saveEditShop(page);

  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('needs_review')
    .eq('vendor_id', vendor.id);
  expect(vcRows?.length).toBeGreaterThanOrEqual(3);
  expect(vcRows?.every((row) => row.needs_review === true)).toBe(true);
});

test('VE-REMOVE-01: vendor removes a category — DB and Radar reflect removal', async ({ page }) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const customerPhone = `88007${Date.now().toString().slice(-5)}`;
  const shopName = `!VE-REMOVE-${Date.now()}`;

  const phone = `99007${Date.now().toString().slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Remove Cat Owner',
      shop_name: shopName,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      upi_id: 'removecat@upi',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  if (error) throw error;

  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  await supabaseAdmin.from('users').upsert({ phone: customerPhone }, { onConflict: 'phone' });
  await supabaseAdmin.from('app_users').upsert({ phone: customerPhone }, { onConflict: 'phone' });

  try {
    await openEditShopSheet(page, phone, vendor.id);
    await deselectCategory(page, plumber.id);
    await saveEditShop(page);

    const { data: vcRows } = await supabaseAdmin
      .from('vendor_categories')
      .select('category_id, categories(label)')
      .eq('vendor_id', vendor.id);
    expect(vcRows?.length).toBe(1);
    const remainingLabel = Array.isArray(vcRows![0].categories)
      ? vcRows![0].categories[0]?.label
      : (vcRows![0].categories as { label: string } | null)?.label;
    expect(remainingLabel).toBe(electrician.label);

    await expectRadarVendorForCategory(page, customerPhone, shopName, plumber.label, false);
    await expectRadarVendorForCategory(page, customerPhone, shopName, electrician.label, true);
  } finally {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendors').delete().eq('id', vendor.id);
    await supabaseAdmin.from('requests').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
    await supabaseAdmin.from('app_users').delete().eq('phone', customerPhone);
  }
});
