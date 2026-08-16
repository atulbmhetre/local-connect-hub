import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorMyBusinessTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
} from './helpers/setup';

const T = Date.now();
const DEVICE = `device_mba_${T}`;
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

async function expandBusiness(
  page: import('@playwright/test').Page,
  categoryId: string,
) {
  const toggle = page.getByTestId(`my-business-accordion-toggle-${categoryId}`);
  await expect(toggle).toBeVisible({ timeout: 10000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

test('MBA-01 — single-business vendor: one expanded accordion, no available-category chips', async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const phone = `99029${String(T).slice(-5)}`;
  createdPhones.push(phone);

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'MBA Single Owner',
      shop_name: `!MBA-SINGLE-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 5,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedDefaultVendorVerification(vendor.id);

  await loginAsVendor(page, phone, vendor.id, DEVICE);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);

  await expect(page.getByTestId('my-business-accordions')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId(`my-business-accordion-${electrician.id}`)).toHaveCount(1);
  await expect(
    page.getByTestId('vendor-edit-category').filter({ has: page.locator('[data-selected="false"]') }),
  ).toHaveCount(0);
  await expect(page.getByText(/Available to add/i)).not.toBeVisible();

  const toggle = page.getByTestId(`my-business-accordion-toggle-${electrician.id}`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId(`my-business-category-settings-${electrician.id}`)).toBeVisible();
});

test('MBA-02 — multi-business vendor: collapsed accordions expand independently; Add Business opens sheet', async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99030${String(T).slice(-5)}`;
  createdPhones.push(phone);

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'MBA Multi Owner',
      shop_name: `!MBA-MULTI-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 5,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  await loginAsVendor(page, phone, vendor.id, DEVICE);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);

  await expect(page.getByTestId(`my-business-accordion-${electrician.id}`)).toBeVisible();
  await expect(page.getByTestId(`my-business-accordion-${plumber.id}`)).toBeVisible();
  await expect(
    page.getByTestId(`my-business-accordion-toggle-${electrician.id}`),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByTestId(`my-business-accordion-toggle-${plumber.id}`),
  ).toHaveAttribute('aria-expanded', 'false');

  await expandBusiness(page, electrician.id);
  await expect(page.getByTestId(`my-business-category-settings-${electrician.id}`)).toBeVisible();
  await expect(page.getByTestId(`my-business-category-settings-${plumber.id}`)).not.toBeVisible();

  await expandBusiness(page, plumber.id);
  await expect(page.getByTestId(`my-business-category-settings-${plumber.id}`)).toBeVisible();

  await page.getByTestId('my-business-add-business').click();
  await expect(page.getByText(/Add another business/i).first()).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('button', { name: electrician.label, exact: false })).not.toBeVisible();
  await expect(page.getByRole('button', { name: plumber.label, exact: false })).not.toBeVisible();
});
