import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const DEVICE_ID = `device_svr_${T}`;

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

test.afterAll(async () => {
  for (const phone of createdPhones) {
    await supabaseAdmin.from('saved_vendor_removal_notices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('saved_vendors').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
});

test('SVR-01 — category removal deletes matching saved_vendors and creates notice', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const vendorPhone = nextPhone('99021');
  const customerPhone = nextPhone('88021');
  const shopName = `!SVR-CAT-${T}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'SVR Cat Owner',
      shop_name: shopName,
      phone: vendorPhone,
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

  await supabaseAdmin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: customerPhone,
    device_id: `${DEVICE_ID}_cat`,
    vendor_id: vendor.id,
    category: plumber.label,
    nickname: shopName,
  });
  // Unrelated save under a kept category — must remain.
  const otherCustomer = nextPhone('88022');
  await supabaseAdmin.from('users').upsert({ phone: otherCustomer, trust_score: 75 }, { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: otherCustomer,
    device_id: `${DEVICE_ID}_keep`,
    vendor_id: vendor.id,
    category: electrician.label,
    nickname: shopName,
  });

  const { error: rpcErr } = await supabaseAdmin.rpc('vendor_update_categories', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendorPhone,
    p_category_ids: [electrician.id],
    p_category_service_modes: [electrician.service_mode],
  });
  expect(rpcErr, rpcErr?.message).toBeNull();

  const { data: removedSaves } = await supabaseAdmin
    .from('saved_vendors')
    .select('id')
    .eq('user_phone', customerPhone)
    .eq('vendor_id', vendor.id);
  expect(removedSaves).toEqual([]);

  const { data: keptSaves } = await supabaseAdmin
    .from('saved_vendors')
    .select('id, category')
    .eq('user_phone', otherCustomer)
    .eq('vendor_id', vendor.id);
  expect(keptSaves?.length).toBe(1);
  expect(keptSaves![0].category).toBe(electrician.label);

  const { data: notices } = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .select('shop_name, category_label, reason, shown_at')
    .eq('user_phone', customerPhone)
    .eq('reason', 'category_removed');
  expect(notices?.length).toBe(1);
  expect(notices![0].shop_name).toBe(shopName);
  expect(notices![0].category_label).toBe(plumber.label);
  expect(notices![0].shown_at).toBeNull();
});

test('SVR-02 — vendor anonymization deletes all saved_vendors and creates account_deleted notice', async () => {
  const plumber = await getActiveCategoryByLabel('Plumber');
  const vendorPhone = nextPhone('99023');
  const customerPhone = nextPhone('88023');
  const shopName = `!SVR-DEL-${T}`;
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

  await supabaseAdmin.from('users').upsert(
    { phone: vendorPhone, trust_score: 75, deletion_requested_at: thirtyOneDaysAgo },
    { onConflict: 'phone' },
  );
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'SVR Del Owner',
      shop_name: shopName,
      phone: vendorPhone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      deletion_requested_at: thirtyOneDaysAgo,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, plumber);

  await supabaseAdmin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: customerPhone,
    device_id: `${DEVICE_ID}_del`,
    vendor_id: vendor.id,
    category: plumber.label,
    nickname: shopName,
  });

  const { error: anonErr } = await supabaseAdmin.rpc('anonymise_deleted_accounts');
  expect(anonErr, anonErr?.message).toBeNull();

  const { data: saves } = await supabaseAdmin
    .from('saved_vendors')
    .select('id')
    .eq('vendor_id', vendor.id);
  expect(saves).toEqual([]);

  const { data: notices } = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .select('shop_name, category_label, reason, shown_at')
    .eq('user_phone', customerPhone)
    .eq('reason', 'account_deleted');
  expect(notices?.length).toBe(1);
  expect(notices![0].shop_name).toBe(shopName);
  expect(notices![0].category_label).toBeNull();
  expect(notices![0].shown_at).toBeNull();

  const { data: anonymised } = await supabaseAdmin
    .from('vendors')
    .select('phone, shop_name')
    .eq('id', vendor.id)
    .single();
  expect(anonymised?.phone).toMatch(/^deleted_/);
  expect(anonymised?.shop_name).toBe('Deleted Shop');
});

test('SVR-03 — Home shows removal flash once as a list; dismiss marks shown', async ({ page }) => {
  const customerPhone = nextPhone('88024');
  await supabaseAdmin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });

  const { data: n1, error: e1 } = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .insert({
      user_phone: customerPhone,
      shop_name: 'Alpha Hardware',
      category_label: 'Plumber',
      reason: 'category_removed',
    })
    .select('id')
    .single();
  if (e1) throw e1;
  const { data: n2, error: e2 } = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .insert({
      user_phone: customerPhone,
      shop_name: 'Beta Mart',
      category_label: null,
      reason: 'account_deleted',
    })
    .select('id')
    .single();
  if (e2) throw e2;

  await loginAsCustomer(page, customerPhone, `${DEVICE_ID}_home`);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 20000 });

  const banner = page.getByTestId('home-saved-vendor-removal-banner');
  await expect(banner).toBeVisible();
  const items = banner.getByTestId('home-saved-vendor-removal-item');
  await expect(items).toHaveCount(2);
  await expect(banner).toContainText('Alpha Hardware');
  await expect(banner).toContainText('no longer offers');
  await expect(banner).toContainText('Beta Mart');
  await expect(banner).toContainText('account closed');

  await page.getByTestId('home-saved-vendor-removal-got-it').click();
  await expect(banner).not.toBeVisible({ timeout: 10000 });

  await expect
    .poll(async () => {
      const { data } = await supabaseAdmin
        .from('saved_vendor_removal_notices')
        .select('shown_at')
        .in('id', [n1.id, n2.id]);
      return data?.every((row) => row.shown_at != null) ?? false;
    }, { timeout: 10000 })
    .toBe(true);

  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('home-saved-vendor-removal-banner')).not.toBeVisible();
});
