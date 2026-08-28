import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  replaceVendorVerification,
} from './helpers/setup';

/**
 * TRUST-BADGE — customer-visible trust badge redesign.
 *
 * Verified vendors show "Verified · [Tier]" (tier from trustLevel.ts);
 * unverified vendors keep "Unverified". Tapping the badge opens a detail
 * sheet with per-check pass/fail/pending state. Ratings display untouched.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88006${String(T).slice(-5)}`;
const DEVICE_ID = `device_tb_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };

const createdVendorIds: string[] = [];

async function createVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; shop_name: string }> {
  const category = await getActiveCategoryByLabel('Grocery Store');
  const shopName = `!TB-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `TB Vendor ${tag}`,
      shop_name: shopName,
      phone: `99007${String(T + createdVendorIds.length + 1).slice(-5)}`,
      category: category.label,
      service_mode: 'delivery',
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 15,
      is_manual_verified: false,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      ...overrides,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  const radiusKm =
    typeof overrides.service_radius_km === 'number' ? overrides.service_radius_km : 15;
  await seedVendorCategory(vendor.id, category, {
    serves_at_customer_place: true,
    service_radius_km: radiusKm,
  });
  createdVendorIds.push(vendor.id);
  return vendor;
}

/** Admin-approved vendor whose passed checks compute to exactly Bronze. */
async function createVerifiedBronzeVendor(tag: string) {
  const vendor = await createVendor(tag, {
    is_manual_verified: true,
    avg_rating: 4.5,
    review_count: 12,
  });
  // Per-business location proof on vendor_categories (VV photo_shop/gps ignored).
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      is_manual_verified: true,
      shop_photo_url: 'https://example.com/test-shop.jpg',
      gps_match_distance: 10,
      location_accuracy: 5,
      photo_accuracy: 5,
      verification_status: 'business_verified',
    })
    .eq('vendor_id', vendor.id);
  // Account-level checks + vendor selfie so VC updates don't re-dormant selfie via sync.
  await supabaseAdmin
    .from('vendors')
    .update({ photo_selfie: 'https://example.com/test-shop.jpg' })
    .eq('id', vendor.id);
  await replaceVendorVerification(vendor.id, [
    { check_type: 'photo_selfie', status: 'passed' },
    { check_type: 'upi_format', status: 'passed' },
    { check_type: 'admin_check', status: 'failed' },
    { check_type: 'upi_pennydrop', status: 'dormant' },
    { check_type: 'aadhaar_digilocker', status: 'dormant' },
  ]);
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

test.beforeEach(async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
});

async function gotoRadarGrocery(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
  await page.goto(`${APP_URL}/radar?q=grocery&mode=delivery`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

function vendorCard(page: Page, shopName: string) {
  return page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
}

test('TB-01 — admin-verified Bronze vendor shows "Verified · Bronze"', async ({ page }) => {
  const vendor = await createVerifiedBronzeVendor('bronze');
  await gotoRadarGrocery(page);
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });

  const badge = card.getByTestId('badge-verified');
  await expect(badge).toBeVisible();
  // Exact combined text — not just "Verified", not just "Bronze".
  await expect(badge).toHaveText('Verified · Bronze');
  await expect(card.getByTestId('badge-unverified')).not.toBeVisible();
});

test('TB-02 — unverified vendor still shows "Unverified"', async ({ page }) => {
  const vendor = await createVendor('unver', { is_manual_verified: false });
  await gotoRadarGrocery(page);
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });

  const badge = card.getByTestId('badge-unverified');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Unverified');
  await expect(card.getByTestId('badge-verified')).not.toBeVisible();
  await expect(card.getByText(/Verified ·/)).not.toBeVisible();
});

test('TB-03 — tapping badge opens detail sheet with correct per-check state', async ({
  page,
}) => {
  const vendor = await createVerifiedBronzeVendor('detail');
  await gotoRadarGrocery(page);
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });

  await card.getByTestId('badge-verified').click();
  const sheet = page.getByTestId('trust-detail-sheet');
  await expect(sheet).toBeVisible({ timeout: 10000 });

  const expected: Record<string, string> = {
    photo_shop: 'passed',
    photo_selfie: 'passed',
    gps: 'passed',
    upi_format: 'passed',
    admin_check: 'failed',
    upi_pennydrop: 'coming_soon',
    aadhaar_digilocker: 'coming_soon',
  };
  for (const [checkType, status] of Object.entries(expected)) {
    const row = sheet.getByTestId(`trust-check-row-${checkType}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-check-status', status);
  }

  // Tier grouping + coming-soon copy for unbuilt Gold/Diamond checks.
  await expect(sheet.getByTestId('trust-tier-group-bronze')).toBeVisible();
  await expect(sheet.getByTestId('trust-tier-group-gold')).toBeVisible();
  await expect(sheet.getByText('Coming soon').first()).toBeVisible();

  // Plain-language labels present.
  await expect(sheet.getByText('Shop Photo')).toBeVisible();
  await expect(sheet.getByText('GPS Location')).toBeVisible();
  await expect(sheet.getByText('Admin Review')).toBeVisible();
  await expect(sheet.getByText('Bank account check (UPI penny-drop)')).toBeVisible();
});

test('TB-04 — ratings display is unaffected by the badge redesign', async ({ page }) => {
  const vendor = await createVerifiedBronzeVendor('ratings');
  await gotoRadarGrocery(page);
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });

  // Ratings line renders exactly as before, alongside the new badge.
  await expect(card.getByText('⭐ 4.5')).toBeVisible();
  await expect(card.getByText('(12 reviews)')).toBeVisible();
  await expect(card.getByTestId('badge-verified')).toHaveText('Verified · Bronze');
});
