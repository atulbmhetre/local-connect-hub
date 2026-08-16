import { test, expect } from '@playwright/test';
import { loginAsVendor, openVendorMyBusinessTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
} from './helpers/setup';
import {
  filterMenuItemsByCategoryContext,
  resolveCancelReasonsForCategory,
  buildCategoryOrderStats,
} from '../src/lib/categoryScopedVendor';

const T = Date.now();
const DEVICE = `device_cma_${T}`;
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_menu_items').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_category_cancel_reasons').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', id);
    await supabaseAdmin.from('requests').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('CMA-01 — multi-category menu items scoped; search context filters', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99031');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'CMA Menu Owner',
      shop_name: `!CMA-MENU-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });

  const { error: insErr } = await supabaseAdmin.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_items: [
      { name: 'Wire fix', price: 100, category_id: electrician.id, sort_order: 0 },
      { name: 'Pipe fix', price: 200, category_id: plumber.id, sort_order: 1 },
    ],
  });
  expect(insErr, insErr?.message).toBeNull();

  const { data: items } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('name, category_id')
    .eq('vendor_id', vendor.id);
  expect(items?.find((i) => i.name === 'Wire fix')?.category_id).toBe(electrician.id);
  expect(items?.find((i) => i.name === 'Pipe fix')?.category_id).toBe(plumber.id);

  const filtered = filterMenuItemsByCategoryContext(items ?? [], plumber.id);
  expect(filtered.map((i) => i.name)).toEqual(['Pipe fix']);
  expect(filterMenuItemsByCategoryContext(items ?? [], null)).toHaveLength(2);
});

test('CMA-02 — single-category vendor: My Business has no menu category picker', async ({
  page,
}) => {
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99032');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'CMA Single Owner',
      shop_name: `!CMA-SINGLE-${T}`,
      phone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      cancel_reason_1: 'Too busy',
      cancel_reason_2: 'Out of stock',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, plumber);
  await seedDefaultVendorVerification(vendor.id);

  await loginAsVendor(page, phone, vendor.id, `${DEVICE}_single`);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);

  const menuBtn = page.getByRole('button', { name: /my menu/i }).first();
  await expect(menuBtn).toBeVisible({ timeout: 8000 });
  if ((await menuBtn.getAttribute('aria-expanded')) !== 'true') await menuBtn.click();

  await page.getByRole('button', { name: /add item/i }).first().click();
  await expect(page.getByTestId('menu-category-picker')).toHaveCount(0);
  await expect(page.getByPlaceholder(/item name/i).first()).toBeVisible();

  const cancelBtn = page.getByRole('button', { name: /rejection reasons|cancel reasons/i }).first();
  if ((await cancelBtn.getAttribute('aria-expanded')) !== 'true') await cancelBtn.click();
  await expect(page.getByTestId('cancel-reason-category-picker')).toHaveCount(0);
});

test('CMA-03 — new category inherits account-level cancel reasons', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99033');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'CMA Reasons Owner',
      shop_name: `!CMA-REASONS-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      cancel_reason_1: 'Account busy',
      cancel_reason_2: 'Account stock',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });

  const { error: rpcErr } = await supabaseAdmin.rpc('vendor_update_categories', {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_category_ids: [electrician.id, plumber.id],
    p_category_service_modes: [electrician.service_mode, plumber.service_mode],
    p_category_modes: {
      [electrician.id]: [electrician.service_mode],
      [plumber.id]: [plumber.service_mode],
    },
  });
  expect(rpcErr, rpcErr?.message).toBeNull();

  const { data: reasons } = await supabaseAdmin
    .from('vendor_category_cancel_reasons')
    .select('reason_text, position')
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id)
    .order('position');
  expect(reasons?.map((r) => r.reason_text)).toEqual(['Account busy', 'Account stock']);
});

test('CMA-04 — cancel reasons resolve category set with account fallback', async () => {
  const map = new Map([['cat-a', ['Cat reason A', 'Cat reason B']]]);
  const account = ['Account 1', 'Account 2', null, ''];
  expect(resolveCancelReasonsForCategory('cat-a', map, account)).toEqual([
    'Cat reason A',
    'Cat reason B',
  ]);
  expect(resolveCancelReasonsForCategory('cat-missing', map, account)).toEqual([
    'Account 1',
    'Account 2',
  ]);
  expect(resolveCancelReasonsForCategory(null, map, account)).toEqual([
    'Account 1',
    'Account 2',
  ]);
});

test('CMA-05 — analytics per-category breakdown', async () => {
  const labels = new Map([
    ['cat-1', 'Plumber'],
    ['cat-2', 'Electrician'],
  ]);
  const stats = buildCategoryOrderStats(
    [
      { status: 'fulfilled', category_id: 'cat-1', delivery_slot_deadline: '2026-01-01T12:00:00Z', fulfilled_at: '2026-01-01T11:00:00Z' },
      { status: 'cancelled', category_id: 'cat-1' },
      { status: 'sent', category_id: 'cat-2' },
      { status: 'fulfilled', category_id: 'cat-2', delivery_slot_deadline: '2026-01-01T12:00:00Z', fulfilled_at: '2026-01-01T13:00:00Z' },
    ],
    labels,
  );
  const plumber = stats.find((s) => s.categoryId === 'cat-1')!;
  const electrician = stats.find((s) => s.categoryId === 'cat-2')!;
  expect(plumber.total).toBe(2);
  expect(plumber.fulfilled).toBe(1);
  expect(plumber.onTimeRate).toBe(100);
  expect(electrician.total).toBe(2);
  expect(electrician.onTimeRate).toBe(0);
});

test('CMA-06 — VendorMode analytics shows category rows', async ({ page }) => {
  const plumber = await getActiveCategoryByLabel('Plumber');
  const electrician = await getActiveCategoryByLabel('Electrician');
  const phone = nextPhone('99034');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'CMA Analytics Owner',
      shop_name: `!CMA-ANALYTICS-${T}`,
      phone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      on_time_rate: 80,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, plumber, { is_primary: true });
  await seedVendorCategory(vendor.id, electrician, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  await supabaseAdmin.from('requests').insert([
    {
      vendor_id: vendor.id,
      user_phone: nextPhone('88034'),
      device_id: `${DEVICE}_r1`,
      message: 'analytics plumber',
      status: 'fulfilled',
      category_id: plumber.id,
    },
    {
      vendor_id: vendor.id,
      user_phone: nextPhone('88035'),
      device_id: `${DEVICE}_r2`,
      message: 'analytics electrician',
      status: 'sent',
      category_id: electrician.id,
    },
  ]);

  await loginAsVendor(page, phone, vendor.id, `${DEVICE}_analytics`);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  const analyticsToggle = page.getByRole('button', { name: /my analytics/i }).first();
  await expect(analyticsToggle).toBeVisible({ timeout: 20000 });
  await analyticsToggle.click();
  await expect(page.getByTestId('vendor-analytics-by-category')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('vendor-analytics-category-row')).toHaveCount(2);
});
