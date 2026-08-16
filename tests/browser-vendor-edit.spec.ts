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
  ensureVendorGoLivePhotos,
  TEST_SESSION,
} from './helpers/setup';
import { setRegAvailabilityModes } from './helpers/regAvailability';

const TEST_DEVICE_ID = `device_edit_${TEST_SESSION}`;
const RADAR_CUSTOMER_DEVICE = `device_mcv_remove_${TEST_SESSION}`;

function myBusinessPanel(page: import('@playwright/test').Page) {
  return page.getByTestId('vendor-my-business');
}

async function openMyBusiness(page: import('@playwright/test').Page, phone: string, vendorId: string) {
  await loginAsVendor(page, phone, vendorId, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('settings-vendor-tab-business')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('settings-vendor-tab-business').click();
  await expect(myBusinessPanel(page)).toBeVisible({ timeout: 10000 });
  await expect(myBusinessPanel(page).locator('.animate-spin')).not.toBeVisible({ timeout: 10000 });
  await expect(myBusinessPanel(page).getByTestId('my-business-accordions')).toBeVisible({
    timeout: 10000,
  });
}

async function expandBusinessAccordion(
  page: import('@playwright/test').Page,
  categoryId: string,
) {
  const toggle = myBusinessPanel(page).getByTestId(`my-business-accordion-toggle-${categoryId}`);
  await expect(toggle).toBeVisible({ timeout: 8000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
}

async function removeBusinessCategory(page: import('@playwright/test').Page, categoryId: string) {
  await expandBusinessAccordion(page, categoryId);
  await myBusinessPanel(page).getByTestId(`my-business-remove-cat-${categoryId}`).click();
}

async function mockVendorGeolocation(page: import('@playwright/test').Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.evaluate(() => {
    (
      window as unknown as {
        __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
      }
    ).__E2E_MOCK_GEO__ = { lat: 18.5204, lng: 73.8567, accuracy: 10 };
  });
}

async function enableE2eCameraMock(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function completeAddBusinessShopPhoto(page: import('@playwright/test').Page) {
  await page.getByTestId('add-business-shop-photo').click();
  const reuseBtn = page.getByTestId('add-business-reuse-photo');
  const sameShop = page.getByTestId('add-business-same-shop');
  try {
    await expect(sameShop).toBeVisible({ timeout: 12000 });
    await reuseBtn.click();
  } catch {
    await expect(page.getByTestId('add-business-shop-photo')).toContainText(
      /Re-shoot|Reshoot|Retake|फिर|पुन्हा/i,
      { timeout: 15000 },
    );
  }
  await expect(page.getByTestId('add-business-shop-photo')).toContainText(
    /Reuse|Re-shoot|Reshoot|Retake|फिर|पुन्हा|दुकान/i,
    { timeout: 10000 },
  );
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
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: false,
      service_radius_km: 5,
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

  const card = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
  if (shouldAppear) {
    await expect(card).toBeVisible({ timeout: 15000 });
  } else {
    await expect(card).not.toBeVisible({ timeout: 8000 });
  }
}

async function saveMyBusiness(
  page: import('@playwright/test').Page,
  dialogAction: 'accept' | 'dismiss' | 'none' = 'accept',
) {
  const saveBtn = page.getByTestId('my-business-save');
  await expect(saveBtn).toBeEnabled({ timeout: 10000 });
  if (dialogAction !== 'none') {
    page.once('dialog', async (dialog) => {
      if (dialogAction === 'accept') await dialog.accept();
      else await dialog.dismiss();
    });
  }
  await saveBtn.click();
  await page.waitForTimeout(2000);
}

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('VE-04: verified vendor can open My Business and change base type', async ({ page }) => {
  const { vendor, phone } = await createEditTestVendor({ is_manual_verified: true, vendor_type: 'shop' });
  await openMyBusiness(page, phone, vendor.id);
  await page.getByTestId('my-business-base-home').click();
  await saveMyBusiness(page);
  const { data } = await supabaseAdmin.from('vendors').select('vendor_type, base_type').eq('id', vendor.id).single();
  expect(data?.vendor_type).toBe('home');
  expect(data?.base_type).toBe('home');
});

test('VE-01: vendor can change vendor_type from shop to home and save', async ({ page }) => {
  const { vendor, phone } = await createEditTestVendor({ vendor_type: 'shop' });
  await openMyBusiness(page, phone, vendor.id);

  await page.getByTestId('my-business-base-home').click();
  await saveMyBusiness(page);

  const { data } = await supabaseAdmin.from('vendors').select('vendor_type').eq('id', vendor.id).single();
  expect(data?.vendor_type).toBe('home');
});

test('VE-02: vendor can add a second category via Add Business sheet', async ({ page }) => {
  const { vendor, phone, categories } = await createEditTestVendor({ vendor_type: 'shop' }, 1);
  const secondCategory = categories[1];
  await ensureVendorGoLivePhotos(vendor.id);

  await enableE2eCameraMock(page);
  await openMyBusiness(page, phone, vendor.id);
  await mockVendorGeolocation(page);

  await page.getByTestId('my-business-add-business').click();
  await expect(page.getByText(/Add another business/i).first()).toBeVisible({ timeout: 10000 });
  const catBtn = page
    .getByRole('button')
    .filter({ hasText: secondCategory.label })
    .filter({ hasText: /Help|Delivery|Appointment|Booking/i });
  await catBtn.first().click();
  await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  await setRegAvailabilityModes(page, ['help'], 'add-business-avail');
  await completeAddBusinessShopPhoto(page);
  await expect(page.getByTestId('add-business-submit')).toBeEnabled({ timeout: 15000 });
  await page.getByTestId('add-business-submit').click();
  await expect(page.getByText(/Business details saved|saved/i)).toBeVisible({ timeout: 30000 });

  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendor.id);
  expect(vcRows?.length).toBe(2);
});

test('VE-03: selecting 3+ categories sets needs_review on vendor_categories rows', async ({
  page,
}) => {
  const categories = await getActiveCategories(3);
  expect(categories.length).toBeGreaterThanOrEqual(3);

  const { vendor, phone } = await createEditTestVendor({ vendor_type: 'shop' }, 3);
  await openMyBusiness(page, phone, vendor.id);
  await saveMyBusiness(page);

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
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: false,
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
    await openMyBusiness(page, phone, vendor.id);
    await removeBusinessCategory(page, plumber.id);

    let confirmMessage = '';
    page.once('dialog', async (dialog) => {
      confirmMessage = dialog.message();
      await dialog.accept();
    });
    await saveMyBusiness(page, 'none');
    expect(confirmMessage).toMatch(/Plumber/i);
    expect(confirmMessage).toMatch(/no longer find you/i);

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

test('VE-REMOVE-02: cancel category-removal confirm keeps both businesses', async ({ page }) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99007${Date.now().toString().slice(-5)}`;
  const shopName = `Fresh Tools Shop ${phone.slice(-4)}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Cancel Remove Owner',
      shop_name: shopName,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      vendor_type: 'shop',
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: false,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      upi_id: 'cancelremove@upi',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  if (error) throw error;

  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  try {
    await openMyBusiness(page, phone, vendor.id);
    await removeBusinessCategory(page, plumber.id);

    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toMatch(/Plumber/i);
      await dialog.dismiss();
    });
    await saveMyBusiness(page, 'none');

    await expect(myBusinessPanel(page).getByTestId(`my-business-accordion-${electrician.id}`)).toBeVisible();
    await expect(myBusinessPanel(page).getByTestId(`my-business-accordion-${plumber.id}`)).toBeVisible();

    const { data: vcRows } = await supabaseAdmin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', vendor.id);
    expect(vcRows?.length).toBe(2);
  } finally {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendors').delete().eq('id', vendor.id);
  }
});

test('VE-RADAR-01: multi-category vendor card shows only matched category on search', async ({ page }) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const customerPhone = `88007${Date.now().toString().slice(-5)}`;
  const phone = `99007${Date.now().toString().slice(-5)}`;
  const shopName = `Fresh Dual Trade ${phone.slice(-4)}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Dual Trade Owner',
      shop_name: shopName,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      vendor_type: 'shop',
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: false,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      upi_id: 'dualtrade@upi',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  if (error) throw error;

  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin.from('users').upsert({ phone: customerPhone }, { onConflict: 'phone' });

  try {
    await loginAsCustomer(page, customerPhone, RADAR_CUSTOMER_DEVICE);
    await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
    await page.context().grantPermissions(['geolocation']);
    await page.goto(
      `${APP_URL}/radar?mode=${plumber.service_mode}&q=${encodeURIComponent(plumber.label)}`,
    );

    const card = page.locator(`#radar-vendor-card-${vendor.id}`);
    await expect(card).toBeVisible({ timeout: 20000 });
    await expect(card.getByText(plumber.label, { exact: false }).first()).toBeVisible();
    await expect(card.getByText(electrician.label, { exact: true })).not.toBeVisible();
  } finally {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendors').delete().eq('id', vendor.id);
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
  }
});
