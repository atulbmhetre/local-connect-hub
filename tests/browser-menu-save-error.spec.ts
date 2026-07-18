import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorPreferencesTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_SESSION,
} from './helpers/setup';

// Reliability fix: menu mutation handlers in VendorSettings previously ignored
// the RPC error, so a failed save silently disappeared. A failed save must now
// surface a visible toast. Failure is forced deterministically by exhausting
// the vendor_insert_menu_items phone rate-limit bucket (30/min).

const T = Date.now();
const DEVICE = `device_menu_err_${T}`;
const RATE_LIMIT_MAX = 30;

let vendorId: string;
let phone: string;

test.beforeAll(async () => {
  const plumber = await getActiveCategoryByLabel('Plumber');
  phone = `99061${String(T).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Menu Error Owner',
      shop_name: `!MENU-ERR-${T}`,
      phone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  vendorId = vendor.id;
  await seedVendorCategory(vendorId, plumber, { is_primary: true });
  await seedDefaultVendorVerification(vendorId);
});

test.afterAll(async () => {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('identifier', phone);
  await supabaseAdmin.from('vendor_menu_items').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendorId);
  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendorId);
  const vcIds = (vcRows ?? []).map((r) => r.id);
  if (vcIds.length) {
    await supabaseAdmin.from('vendor_category_modes').delete().in('vendor_category_id', vcIds);
  }
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
});

test('MERR-01 — failed menu save surfaces a visible error toast (no silent drop)', async ({
  page,
}) => {
  // Exhaust the insert bucket so the UI save deterministically fails.
  const rows = Array.from({ length: RATE_LIMIT_MAX }, () => ({
    function_name: 'vendor_insert_menu_items',
    identifier_type: 'phone',
    identifier: phone,
  }));
  const { error: seedErr } = await supabaseAdmin
    .from('edge_function_rate_limits')
    .insert(rows);
  expect(seedErr, seedErr?.message).toBeNull();

  await loginAsVendor(page, phone, vendorId, DEVICE);
  await page.goto(`${APP_URL}/settings`);
  await openVendorPreferencesTab(page);

  const menuBtn = page.getByRole('button', { name: /my menu/i }).first();
  await expect(menuBtn).toBeVisible({ timeout: 8000 });
  if ((await menuBtn.getAttribute('aria-expanded')) !== 'true') await menuBtn.click();

  await page.getByRole('button', { name: /add item/i }).first().click();
  await page.getByPlaceholder(/item name/i).first().fill('Toast check item');
  await page.getByPlaceholder(/price/i).first().fill('42');
  await page.getByRole('button', { name: /^save$/i }).first().click();

  // The RPC failure must be visible to the vendor.
  await expect(
    page.locator('[data-sonner-toast]').getByText(/rate_limited/i),
  ).toBeVisible({ timeout: 8000 });

  // And the add-item form must remain open (save did not silently "succeed").
  await expect(page.getByPlaceholder(/item name/i).first()).toBeVisible();
  await expect(page.getByPlaceholder(/item name/i).first()).toHaveValue('Toast check item');

  // Nothing was persisted.
  const { data: items } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', vendorId);
  expect(items ?? []).toHaveLength(0);

  // Clear the bucket — the same save should now succeed and close the form.
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', 'vendor_insert_menu_items')
    .eq('identifier', phone);

  await page.getByRole('button', { name: /^save$/i }).first().click();
  await expect(page.getByPlaceholder(/item name/i)).toHaveCount(0, { timeout: 8000 });

  const { data: saved } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('name')
    .eq('vendor_id', vendorId);
  expect(saved?.map((i) => i.name)).toContain('Toast check item');
});
