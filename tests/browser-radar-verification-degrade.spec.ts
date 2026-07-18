import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

/**
 * RAD-VER-DEGRADE — Radar must tolerate a vendor_verification query failure.
 *
 * The trust-tier batch read only feeds sort weighting; if it errors, the
 * search must still return vendor cards (all treated as Unverified) instead
 * of failing the whole page.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88005${String(T).slice(-5)}`;
const DEVICE_ID = `device_radver_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };

const createdVendorIds: string[] = [];

async function createNearbyVendor(tag: string): Promise<{ id: string; shop_name: string }> {
  const category = await getActiveCategoryByLabel('Grocery Store');
  const shopName = `!RADVER-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `RADVER Vendor ${tag}`,
      shop_name: shopName,
      phone: `99005${String(T + createdVendorIds.length + 1).slice(-5)}`,
      category: category.label,
      service_mode: 'delivery',
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 9999,
      is_manual_verified: false,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, { serves_at_customer_place: true });
  createdVendorIds.push(vendor.id);
  return vendor;
}

test.beforeAll(async () => {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
});

test.afterAll(async () => {
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_verification').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

async function gotoRadar(page: Page, q: string) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
  await page.goto(`${APP_URL}/radar?q=${encodeURIComponent(q)}&mode=delivery`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

test('RAD-VER-01 — vendor_verification query failure does not blank Radar results', async ({
  page,
}) => {
  const vendor = await createNearbyVendor('degrade');

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);

  // Force the trust-tier batch read to fail with a server error.
  let verificationRequests = 0;
  await page.route('**/rest/v1/vendor_verification*', async (route) => {
    verificationRequests += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'simulated vendor_verification outage' }),
    });
  });

  await gotoRadar(page, 'grocery');

  // The search must still surface the seeded vendor's card.
  const card = page.getByTestId('radar-vendor-card').filter({ hasText: vendor.shop_name });
  await expect(card).toBeVisible({ timeout: 25000 });

  // Prove the failure path was actually exercised, not skipped.
  expect(verificationRequests).toBeGreaterThan(0);

  // No error state should be shown for the search itself.
  await expect(page.getByText('Connection Error')).not.toBeVisible();
  await expect(page.getByText('simulated vendor_verification outage')).not.toBeVisible();
});
