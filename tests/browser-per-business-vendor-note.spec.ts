import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_VENDOR_SHOP_PHOTO,
} from './helpers/setup';
import { resolveCategoryVendorNote } from '../src/lib/categoryScopedVendor';

const T = Date.now();
const CUSTOMER_PHONE = `88009${String(T).slice(-5)}`;
const DEVICE_ID = `device_pbn_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

async function seedCustomer() {
  await supabaseAdmin.from('users').upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
}

test('PBN-01 — resolveCategoryVendorNote picks business note over account', () => {
  const account = 'ACCOUNT NOTE WRONG';
  expect(resolveCategoryVendorNote('Business plumber note', account, 'plumber-id')).toBe(
    'Business plumber note',
  );
  expect(resolveCategoryVendorNote(null, account, 'plumber-id')).toBe(account);
  expect(resolveCategoryVendorNote('Business note', account, null)).toBe(account);
});

test('PBN-02 — ParchiSheet shows per-business note not account note', async ({ page }) => {
  await seedCustomer();
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const shopName = `!PBN-RADAR-${T}`;
  const elecNote = `ELEC-NOTE-${T}`;
  const plumNote = `PLUM-NOTE-${T}`;
  const accountNote = `ACCOUNT-NOTE-${T}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBN Radar Owner',
      shop_name: shopName,
      phone: `99019${String(T).slice(-5)}`,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      subscription_status: 'active',
      service_radius_km: 9999,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      vendor_note: accountNote,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin.from('vendors').update({ discoverable: true, subscription_status: 'active' }).eq('id', vendor.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({
      vendor_note: elecNote,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: 'business_verified',
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({
      vendor_note: plumNote,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: 'business_verified',
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.context().setGeolocation({ latitude: PUNE.latitude, longitude: PUNE.longitude });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?mode=help&q=${encodeURIComponent(electrician.label)}`);

  const card = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
  await expect(card).toBeVisible({ timeout: 25000 });

  await card.getByTestId('radar-vendor-card-order-btn').click();
  await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('parchi-sheet').getByText(elecNote)).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('parchi-sheet').getByText(accountNote)).toHaveCount(0);
});

test('PBN-03 — RadarVendorCard rate card shows per-business note not account note', async ({
  page,
}) => {
  await seedCustomer();
  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const shopName = `!PBN-RATE-${T}`;
  const elecNote = `RATE-PHARM-${T}`;
  const accountNote = `RATE-ACCT-${T}`;

  const vendorPhone = `99039${String(T).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBN Rate Owner',
      shop_name: shopName,
      phone: vendorPhone,
      category: pharmacy.label,
      service_mode: 'delivery',
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      subscription_status: 'active',
      service_radius_km: 9999,
      serves_at_customer_place: true,
      vendor_note: accountNote,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, pharmacy, {
    is_primary: true,
    serves_at_customer_place: true,
  });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      vendor_note: elecNote,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: 'business_verified',
      serves_at_customer_place: true,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', pharmacy.id);

  const { error: menuErr } = await supabaseAdmin.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendorPhone,
    p_items: [
      { name: `Rate item A ${T}`, price: 99, category_id: pharmacy.id, sort_order: 0 },
      { name: `Rate item B ${T}`, price: 89, category_id: pharmacy.id, sort_order: 1 },
      { name: `Rate item C ${T}`, price: 79, category_id: pharmacy.id, sort_order: 2 },
      { name: `Rate item D ${T}`, price: 69, category_id: pharmacy.id, sort_order: 3 },
    ],
  });
  expect(menuErr, menuErr?.message).toBeNull();

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.context().setGeolocation({ latitude: PUNE.latitude, longitude: PUNE.longitude });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?mode=delivery&q=${encodeURIComponent(pharmacy.label)}`);

  const card = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
  await expect(card).toBeVisible({ timeout: 25000 });
  await card.getByRole('button', { name: /view full menu|view full rate card/i }).click();
  await expect(page.getByText(elecNote)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(accountNote)).toHaveCount(0);
});

test('PBN-04 — AiBridgeSheet shows per-business note not account note', async ({ page }) => {
  await seedCustomer();
  const electrician = await getActiveCategoryByLabel('Electrician');
  const shopName = `!PBN-BRIDGE-${T}`;
  const elecNote = `BRIDGE-ELEC-${T}`;
  const accountNote = `BRIDGE-ACCT-${T}`;
  const vendorPhone = `99029${String(T).slice(-5)}`;

  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBN Bridge Owner',
      shop_name: shopName,
      phone: vendorPhone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      subscription_status: 'active',
      service_radius_km: 9999,
      vendor_note: accountNote,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      vendor_note: elecNote,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: 'business_verified',
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.context().setGeolocation({ latitude: PUNE.latitude, longitude: PUNE.longitude });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?mode=help&q=${encodeURIComponent(electrician.label)}`);

  const card = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
  await expect(card).toBeVisible({ timeout: 25000 });
  await card.getByRole('button', { name: /^Call$/i }).click();
  await expect(page.getByText(/AI-Bridge|AI Bridge/i).first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(elecNote)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(accountNote)).toHaveCount(0);
});
