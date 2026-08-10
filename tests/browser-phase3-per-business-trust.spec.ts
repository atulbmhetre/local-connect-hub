import { test, expect, type Page } from '@playwright/test';
import {
  loginAsCustomer,
  loginAsAdminViaSession,
  ensureTestAdminUser,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  replaceVendorVerification,
  TEST_VENDOR_SHOP_PHOTO,
  TEST_SESSION,
} from './helpers/setup';
import {
  computeTrustLevelForBusiness,
  statusForBusinessCheck,
} from '../src/lib/trustLevel';

/**
 * Phase 3 evidence — per-business trust tiers (TEST only).
 * Same vendor account, Cobbler (photo+gps) vs Carpenter (no photo) must show
 * different badges. Colocated twins with shared proof must match.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88008${String(T).slice(-5)}`;
const DEVICE_ID = `device_p3_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];

async function seedAccountBronzeChecks(vendorId: string) {
  // Stale account-level photo_shop/gps must NOT inflate Carpenter.
  await replaceVendorVerification(vendorId, [
    { check_type: 'upi_format', status: 'passed' },
    { check_type: 'photo_selfie', status: 'passed' },
    { check_type: 'photo_shop', status: 'passed' },
    { check_type: 'gps', status: 'passed' },
    { check_type: 'admin_check', status: 'dormant' },
    { check_type: 'upi_pennydrop', status: 'dormant' },
    { check_type: 'aadhaar_digilocker', status: 'dormant' },
  ]);
}

async function createSplitProofVendor(
  tag: string,
  opts: { categoryManualVerified?: boolean } = {},
) {
  const categoryManualVerified = opts.categoryManualVerified ?? true;
  const cobbler = await getActiveCategoryByLabel('Cobbler');
  const carpenter = await getActiveCategoryByLabel('Carpenter');
  const shopName = `!P3-Split-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'P3 Split Owner',
      shop_name: shopName,
      phone: `99018${String(T + tag.length * 17 + (categoryManualVerified ? 0 : 3)).slice(-5)}`,
      category: cobbler.label,
      service_mode: cobbler.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 9999,
      is_manual_verified: categoryManualVerified,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, cobbler, {
    is_primary: true,
    is_manual_verified: categoryManualVerified,
    serves_at_customer_place: true,
  });
  await seedVendorCategory(vendor.id, carpenter, {
    is_primary: false,
    is_manual_verified: categoryManualVerified,
    serves_at_customer_place: true,
  });

  // Cobbler: real location proof. Carpenter: strip photo (no inherit).
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      gps_match_distance: 12,
      location_accuracy: 5,
      photo_accuracy: 5,
      verification_status: 'business_verified',
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_manual_verified: categoryManualVerified,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', cobbler.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({
      shop_photo_url: null,
      gps_match_distance: null,
      location_accuracy: null,
      photo_accuracy: null,
      verification_status: null,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_manual_verified: categoryManualVerified,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', carpenter.id);

  await seedAccountBronzeChecks(vendor.id);
  return { vendor, cobbler, carpenter, shopName };
}

async function createColocatedTwinVendor() {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const shopName = `!P3-Twin-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'P3 Twin Owner',
      shop_name: shopName,
      phone: `99019${String(T).slice(-5)}`,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 9999,
      is_manual_verified: true,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, electrician, {
    is_primary: true,
    is_manual_verified: true,
    serves_at_customer_place: true,
  });
  await seedVendorCategory(vendor.id, plumber, {
    is_primary: false,
    is_manual_verified: true,
    serves_at_customer_place: true,
  });

  const proof = {
    shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
    gps_match_distance: 8,
    location_accuracy: 5,
    photo_accuracy: 5,
    verification_status: 'business_verified',
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    is_manual_verified: true,
  };
  await supabaseAdmin
    .from('vendor_categories')
    .update(proof)
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update(proof)
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  await seedAccountBronzeChecks(vendor.id);
  return { vendor, electrician, plumber, shopName };
}

async function gotoRadar(page: Page, q: string, mode = 'help') {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
  await page.goto(`${APP_URL}/radar?q=${encodeURIComponent(q)}&mode=${mode}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

function vendorCard(page: Page, shopName: string) {
  return page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
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

test('P3-a: Cobbler Bronze vs Carpenter Unverified on same account (Radar badges)', async ({
  page,
}) => {
  test.setTimeout(90000);
  const { vendor, cobbler, carpenter, shopName } = await createSplitProofVendor('a');

  const { data: verRows } = await supabaseAdmin
    .from('vendor_verification')
    .select('vendor_id, check_type, status, is_latest')
    .eq('vendor_id', vendor.id)
    .eq('is_latest', true);
  const { data: bizRows } = await supabaseAdmin
    .from('vendor_categories')
    .select(
      'vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status',
    )
    .eq('vendor_id', vendor.id);

  const cobblerTier = computeTrustLevelForBusiness(
    vendor.id,
    cobbler.id,
    verRows ?? [],
    bizRows ?? [],
  );
  const carpenterTier = computeTrustLevelForBusiness(
    vendor.id,
    carpenter.id,
    verRows ?? [],
    bizRows ?? [],
  );
  expect(cobblerTier).toBe('Bronze');
  expect(carpenterTier).toBe('Unverified');
  expect(statusForBusinessCheck('upi_format', vendor.id, carpenter.id, verRows ?? [], bizRows ?? [])).toBe(
    'passed',
  );
  expect(statusForBusinessCheck('photo_selfie', vendor.id, carpenter.id, verRows ?? [], bizRows ?? [])).toBe(
    'passed',
  );
  expect(statusForBusinessCheck('photo_shop', vendor.id, carpenter.id, verRows ?? [], bizRows ?? [])).toBe(
    'pending',
  );

  // Cobbler search card
  await gotoRadar(page, cobbler.label, cobbler.service_mode === 'delivery' ? 'delivery' : 'help');
  const cobblerCard = vendorCard(page, shopName);
  await expect(cobblerCard).toBeVisible({ timeout: 25000 });
  const cobblerBadge = cobblerCard.getByTestId('badge-verified');
  await expect(cobblerBadge).toBeVisible();
  await expect(cobblerBadge).toHaveText('Verified · Bronze');
  await expect(cobblerBadge).toHaveAttribute('data-trust-level', 'Bronze');
  await expect(cobblerBadge).toHaveAttribute('data-category-id', cobbler.id);

  const cobblerSnap = await cobblerBadge.ariaSnapshot();
  console.log('P3-a Cobbler badge aria:', cobblerSnap);
  console.log('P3-a Cobbler DB tier:', cobblerTier, 'Carpenter DB tier:', carpenterTier);

  // Carpenter search card — same shop, lower tier
  await gotoRadar(page, carpenter.label, carpenter.service_mode === 'delivery' ? 'delivery' : 'help');
  const carpenterCard = vendorCard(page, shopName);
  await expect(carpenterCard).toBeVisible({ timeout: 25000 });
  // Manual verified but missing photo_shop → still shows Verified · Unverified? 
  // Product: is_manual_verified true shows "Verified · [Tier]"; Unverified tier means plain Verified without tier label.
  const carpenterBadge = carpenterCard.locator(
    '[data-testid="badge-verified"], [data-testid="badge-unverified"]',
  );
  await expect(carpenterBadge).toBeVisible();
  await expect(carpenterBadge).toHaveAttribute('data-trust-level', 'Unverified');
  await expect(carpenterBadge).toHaveAttribute('data-category-id', carpenter.id);
  await expect(carpenterBadge).not.toHaveText(/Bronze|Silver|Gold|Diamond/);

  const carpenterSnap = await carpenterBadge.ariaSnapshot();
  console.log('P3-a Carpenter badge aria:', carpenterSnap);
});

test('P3-b: colocated businesses with shared proof show same Bronze tier', async ({ page }) => {
  test.setTimeout(90000);
  const { vendor, electrician, plumber, shopName } = await createColocatedTwinVendor();

  const { data: verRows } = await supabaseAdmin
    .from('vendor_verification')
    .select('vendor_id, check_type, status, is_latest')
    .eq('vendor_id', vendor.id)
    .eq('is_latest', true);
  const { data: bizRows } = await supabaseAdmin
    .from('vendor_categories')
    .select(
      'vendor_id, category_id, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status',
    )
    .eq('vendor_id', vendor.id);

  expect(
    computeTrustLevelForBusiness(vendor.id, electrician.id, verRows ?? [], bizRows ?? []),
  ).toBe('Bronze');
  expect(
    computeTrustLevelForBusiness(vendor.id, plumber.id, verRows ?? [], bizRows ?? []),
  ).toBe('Bronze');

  for (const cat of [electrician, plumber]) {
    await gotoRadar(page, cat.label, cat.service_mode === 'delivery' ? 'delivery' : 'help');
    const card = vendorCard(page, shopName);
    await expect(card).toBeVisible({ timeout: 25000 });
    const badge = card.getByTestId('badge-verified');
    await expect(badge).toHaveText('Verified · Bronze');
    await expect(badge).toHaveAttribute('data-trust-level', 'Bronze');
    await expect(badge).toHaveAttribute('data-category-id', cat.id);
    console.log(`P3-b ${cat.label} badge:`, await badge.ariaSnapshot());
  }
});

test('P3-c+d: account checks shared; admin verify sheet differs per open category', async ({
  page,
}) => {
  test.setTimeout(120000);
  const { vendor, cobbler, carpenter, shopName } = await createSplitProofVendor('cd', {
    categoryManualVerified: false,
  });

  await loginAsAdminViaSession(page, DEVICE_ID);
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 8000 });
  const modBtn = page.getByRole('button', { name: /Vendor Moderation/i }).first();
  const hasMod = await modBtn.isVisible({ timeout: 3000 }).catch(() => false);
  if (hasMod) {
    const expanded = await page
      .getByPlaceholder(/search/i)
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (!expanded) {
      await modBtn.click();
      await page.waitForTimeout(500);
    }
  }
  const searchInput = page.getByPlaceholder(/search/i).first();
  await expect(searchInput).toBeVisible({ timeout: 20000 });
  await searchInput.fill(shopName);
  await page.waitForTimeout(600);

  const vendorRow = page.locator(`#admin-vendor-${vendor.id}`);
  await expect(vendorRow).toBeVisible({ timeout: 20000 });

  // Open Cobbler verify
  await vendorRow.locator(`button[title="${cobbler.label}"]`).click({ timeout: 10000 });
  await expect(page.getByText('Verification checks')).toBeVisible({ timeout: 8000 });
  const cobblerPhoto = page.getByTestId('admin-check-row-photo_shop');
  await expect(cobblerPhoto).toHaveAttribute('data-check-status', 'passed');
  await expect(page.getByTestId('admin-check-row-upi_format')).toHaveAttribute(
    'data-check-status',
    'passed',
  );
  await expect(page.getByTestId('admin-check-row-photo_selfie')).toHaveAttribute(
    'data-check-status',
    'passed',
  );
  await expect(page.getByTestId('admin-trust-tier-group-bronze')).toHaveAttribute(
    'data-tier-reached',
    'true',
  );
  await expect(page.getByTestId('admin-trust-tier-group-bronze')).toHaveAttribute(
    'data-open-trust-level',
    'Bronze',
  );
  console.log(
    'P3-d Cobbler admin sheet:',
    await page.getByTestId('admin-trust-tier-group-bronze').ariaSnapshot(),
  );

  // Close Cobbler sheet before opening Carpenter
  await page.getByRole('button', { name: /Cancel|Close|Back/i }).last().click();
  await expect(page.getByTestId('admin-check-row-photo_shop')).toHaveCount(0, { timeout: 8000 });

  // Open Carpenter verify
  await vendorRow.locator(`button[title="${carpenter.label}"]`).click({ timeout: 10000 });
  await expect(page.getByText('Verification checks')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('admin-check-row-photo_shop')).toHaveAttribute(
    'data-check-status',
    'pending',
  );
  await expect(page.getByTestId('admin-check-row-upi_format')).toHaveAttribute(
    'data-check-status',
    'passed',
  );
  await expect(page.getByTestId('admin-trust-tier-group-bronze')).toHaveAttribute(
    'data-tier-reached',
    'false',
  );
  await expect(page.getByTestId('admin-trust-tier-group-bronze')).toHaveAttribute(
    'data-open-trust-level',
    'Unverified',
  );
  console.log(
    'P3-d Carpenter admin sheet:',
    await page.getByTestId('admin-trust-tier-group-bronze').ariaSnapshot(),
  );
});
