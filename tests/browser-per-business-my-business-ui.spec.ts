import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorMyBusinessTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
} from './helpers/setup';

/**
 * Step-4 style verification on TEST: multi-business vendor My Business operations
 * (menu scoped, cancel reasons per slot, note editor per slot).
 */
const T = Date.now();
const DEVICE = `device_mbv_${T}`;
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_menu_items').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_category_cancel_reasons').delete().eq('vendor_id', id);
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
}

async function openOpsSection(
  page: import('@playwright/test').Page,
  categoryId: string,
  label: RegExp,
) {
  const panel = page.getByTestId(`my-business-category-settings-${categoryId}`);
  const ops = panel.getByTestId('my-business-operations');
  const btn = ops.getByRole('button', { name: label }).first();
  await expect(btn).toBeVisible({ timeout: 10000 });
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
}

test('MBV-01 — My Business ops: menu, cancel reasons, and note scoped per business', async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99028${String(T).slice(-5)}`;
  createdPhones.push(phone);
  const elecNote = `MBV-ELEC-NOTE-${T}`;
  const plumNote = `MBV-PLUM-NOTE-${T}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'MBV Ops Owner',
      shop_name: `!MBV-OPS-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      vendor_note: `MBV-ACCOUNT-NOTE-${T}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({ vendor_note: elecNote })
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ vendor_note: plumNote })
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  const { error: menuErr } = await supabaseAdmin.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_items: [
      { name: `Elec item ${T}`, price: 100, category_id: electrician.id, sort_order: 0 },
      { name: `Plum item ${T}`, price: 200, category_id: plumber.id, sort_order: 1 },
    ],
  });
  expect(menuErr, menuErr?.message).toBeNull();

  await supabaseAdmin.from('vendor_category_cancel_reasons').insert([
    {
      vendor_id: vendor.id,
      category_id: electrician.id,
      position: 1,
      reason_text: `Elec busy ${T}`,
    },
    {
      vendor_id: vendor.id,
      category_id: plumber.id,
      position: 1,
      reason_text: `Plum busy ${T}`,
    },
  ]);

  await loginAsVendor(page, phone, vendor.id, DEVICE);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expect(page.getByTestId('my-business-accordions')).toBeVisible({ timeout: 10000 });

  await expandBusiness(page, electrician.id);
  await openOpsSection(page, electrician.id, /my menu/i);
  const elecOps = page
    .getByTestId(`my-business-category-settings-${electrician.id}`)
    .getByTestId('my-business-operations');
  await expect(elecOps.getByText(`Elec item ${T}`)).toBeVisible({ timeout: 10000 });
  await expect(elecOps.getByText(`Plum item ${T}`)).not.toBeVisible();

  await expandBusiness(page, plumber.id);
  await openOpsSection(page, plumber.id, /my menu/i);
  const plumOps = page
    .getByTestId(`my-business-category-settings-${plumber.id}`)
    .getByTestId('my-business-operations');
  await expect(plumOps.getByText(`Plum item ${T}`)).toBeVisible({ timeout: 10000 });
  await expect(plumOps.getByText(`Elec item ${T}`)).not.toBeVisible();

  await openOpsSection(page, electrician.id, /rejection reasons|cancel reasons/i);
  await expect(elecOps.locator('input').first()).toHaveValue(`Elec busy ${T}`);

  await openOpsSection(page, plumber.id, /rejection reasons|cancel reasons/i);
  await expect(plumOps.locator('input').first()).toHaveValue(`Plum busy ${T}`);

  await openOpsSection(page, electrician.id, /note for customers/i);
  await expect(elecOps.locator('textarea').first()).toHaveValue(elecNote);

  await openOpsSection(page, plumber.id, /note for customers/i);
  await expect(plumOps.locator('textarea').first()).toHaveValue(plumNote);
});
