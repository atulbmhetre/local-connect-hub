import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88004${String(T).slice(-5)}`;
const DEVICE_ID = `device_rad_${T}`;
const TEST_CUSTOMER_PHONE = CUSTOMER_PHONE;
const TEST_DEVICE_ID = DEVICE_ID;

const L = {
  sosHeadline: 'Emergency help nearby',
  sosSubtitle: 'Need delivery or a booking? Search by category above.',
  vendorWentOffline:
    'This vendor just went offline. Please try another or check back soon.',
  orderSent: 'Order Sent',
  savedButton: 'Saved ✓',
  unknownTerm: (term: string) => `We couldn't find '${term}'`,
  myNeighbourhood: 'MY NEIGHBOURHOOD',
  trustBronze: '🥉 Bronze',
  trustDiamond: '💎 Diamond',
  trustGold: '🥇 Gold',
  trustSilver: '🥈 Silver',
  unverified: 'Unverified',
  govAmbulance: '108 Ambulance',
} as const;

const PUNE = { latitude: 18.5204, longitude: 73.8567 };

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdSavedIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99004${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

type VendorRow = {
  id: string;
  shop_name: string;
  category: string;
  service_mode: string;
};

async function createNearbyVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  categoryLabel: string,
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  const category = await getActiveCategoryByLabel(categoryLabel);
  const shopName = `!RAD-${tag}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `RAD Vendor ${tag}`,
      shop_name: shopName,
      phone: nextVendorPhone(),
      category: category.label,
      service_mode: serviceMode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 9999,
      is_manual_verified: false,
      // Empty delivery browse uses account-level reach when no category match context.
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      ...overrides,
    })
    .select('id, shop_name, category, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, { serves_at_customer_place: true });
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<VendorRow> {
  return createNearbyVendor(serviceMode, 'Grocery Store', tag, overrides);
}

async function gotoRadarDelivery(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?mode=delivery`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

async function waitForScanComplete(page: Page) {
  await page.waitForFunction(
    () => document.querySelector('[data-scanning]')?.getAttribute('data-scanning') === 'false',
    { timeout: 20000 },
  );
}

async function seedSavedVendor(vendor: VendorRow, nickname?: string) {
  const { data, error } = await supabaseAdmin
    .from('saved_vendors')
    .insert({
      device_id: DEVICE_ID,
      user_phone: CUSTOMER_PHONE,
      vendor_id: vendor.id,
      nickname: nickname ?? vendor.shop_name,
      category: vendor.category,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdSavedIds.push(data.id);
  return data;
}

async function seedActiveOrder(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message: `RAD-ORDER-${T}`,
      status: 'sent',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function setupGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
}

async function gotoRadar(
  page: Page,
  opts: { q?: string; mode?: 'help' | 'delivery' | 'appointment' } = {},
) {
  await setupGeolocation(page);
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.mode) params.set('mode', opts.mode);
  const qs = params.toString();
  await page.goto(`${APP_URL}/radar${qs ? `?${qs}` : ''}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

function vendorCard(page: Page, shopName: string) {
  return page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
}

async function waitForVendorCard(page: Page, shopName: string) {
  await expect(vendorCard(page, shopName)).toBeVisible({ timeout: 25000 });
}

test.beforeAll(async () => {
  await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await seedCustomer();
});

test.afterAll(async () => {
  if (createdSavedIds.length) {
    await supabaseAdmin.from('saved_vendors').delete().in('id', createdSavedIds);
  }
  await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', CUSTOMER_PHONE);
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
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

// ─── CATEGORY RESOLUTION ───────────────────────────────────────────────────

test('RAD-01a — Search "kirana" resolves to Grocery vendors', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'kirana');
  await gotoRadar(page, { q: 'kirana', mode: 'delivery' });
  await waitForVendorCard(page, vendor.shop_name);
  await expect(page.getByText(L.unknownTerm('kirana'))).not.toBeVisible();
});

test('RAD-01b — Search "mikanik" resolves to Mechanic vendors (Hindi alias)', async ({ page }) => {
  const vendor = await createNearbyVendor('help', 'Mechanic', 'mikanik');
  await gotoRadar(page, { q: 'mikanik', mode: 'help' });
  await waitForVendorCard(page, vendor.shop_name);
  await expect(page.getByText(/couldn't find/i)).not.toBeVisible();
  await expect(page.locator('[class*="destructive"]').filter({ hasText: /error/i })).not.toBeVisible();
});

// ─── SOS MODE ──────────────────────────────────────────────────────────────

test('RAD-05a — Empty search shows help vendors only', async ({ page }) => {
  const helpVendor = await createNearbyVendor('help', 'Mechanic', 'sos-help');
  const deliveryVendor = await createNearbyVendor('delivery', 'Grocery Store', 'sos-del');
  await gotoRadar(page);
  await waitForVendorCard(page, helpVendor.shop_name);
  await expect(vendorCard(page, deliveryVendor.shop_name)).not.toBeVisible();
  await expect(page.getByRole('heading', { name: L.sosHeadline })).toBeVisible();
});

test('RAD-05b — SOS page shows correct subtitle', async ({ page }) => {
  await createNearbyVendor('help', 'Mechanic', 'sos-sub-help');
  await createNearbyVendor('delivery', 'Grocery Store', 'sos-sub-del');
  await gotoRadar(page);
  await expect(page.getByText(L.sosSubtitle)).toBeVisible();
});

// ─── VENDOR CARD — ONLINE/OFFLINE ──────────────────────────────────────────

test('RAD-07a — Online vendor shows green dot', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'online', {
    is_active: true,
  });
  await gotoRadar(page, { q: 'grocery', mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  // MISSING TESTID: needs data-testid="radar-vendor-online-dot" on RadarVendorCard.tsx
  await expect(card.locator('span[aria-label="Online"]')).toBeVisible();
});

test('RAD-07b — Offline vendor card — action blocked', async ({ page }) => {
  const vendor = await createNearbyVendor('help', 'Mechanic', 'offline-tap');
  await gotoRadar(page, { q: 'mikanik', mode: 'help' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await supabaseAdmin.from('vendors').update({ is_active: false }).eq('id', vendor.id);
  await card.getByTestId('radar-vendor-card-order-btn').click();
  await expect(
    page.locator('[data-sonner-toast]').getByText(L.vendorWentOffline, { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('parchi-sheet')).not.toBeVisible();
});

// ─── TRUST BADGE — BINARY Verified / Unverified (per-business) ─────────────

test('RAD-09a — Unverified vendor shows VerificationBadge only', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'unverified', {
    is_manual_verified: false,
    shop_photo_url: null,
    upi_verified: false,
    verification_status: null,
    serves_at_customer_place: true,
  });
  await gotoRadar(page, { q: 'grocery', mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  // BusinessVerificationBadge with showLabel — visible label text, no title attribute
  const unverifiedBadge = card.getByTestId('badge-unverified');
  await expect(unverifiedBadge).toBeVisible();
  await expect(unverifiedBadge).toHaveText(/Unverified|असत्यापित/i);
  await expect(card.getByTestId('badge-verified')).not.toBeVisible();
  await expect(card.getByText(L.trustBronze, { exact: true })).not.toBeVisible();
  await expect(card.getByText(L.trustGold, { exact: true })).not.toBeVisible();
  await expect(card.getByText(L.trustSilver, { exact: true })).not.toBeVisible();
  await expect(card.getByText(L.trustDiamond, { exact: true })).not.toBeVisible();
});

test('RAD-09b — Manually verified vendor shows Verified badge only', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'verified', {
    is_manual_verified: true,
    upi_verified: true,
    photo_selfie: 'https://picsum.photos/seed/rad09b/100',
    serves_at_customer_place: true,
  });
  // Per-business badge reads vendor_categories.is_manual_verified
  await supabaseAdmin
    .from('vendor_categories')
    .update({ is_manual_verified: true, serves_at_customer_place: true })
    .eq('vendor_id', vendor.id);
  await gotoRadar(page, { q: 'grocery', mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  const verifiedBadge = card.getByTestId('badge-verified');
  await expect(verifiedBadge).toBeVisible();
  await expect(verifiedBadge).toHaveText(/Verified|सत्यापित/i);
  await expect(card.getByTestId('badge-unverified')).not.toBeVisible();
  await expect(card.getByText(L.trustBronze, { exact: true })).not.toBeVisible();
});

// ─── SAVED NEIGHBOURS ──────────────────────────────────────────────────────

test('RAD-08a — Saved vendor appears in neighbours regardless of online status', async ({
  page,
}) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'saved-offline');
  await seedSavedVendor(vendor);
  await supabaseAdmin.from('vendors').update({ is_active: false }).eq('id', vendor.id);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText(L.myNeighbourhood)).toBeVisible();
  // MISSING TESTID: needs data-testid="saved-neighbour-tile" on Index.tsx
  const tile = page.getByRole('button').filter({ hasText: vendor.shop_name });
  await expect(tile).toBeVisible({ timeout: 15000 });
  await expect(tile.locator('span[aria-label="Online"]')).not.toBeVisible();
});

test('RAD-08b — Tapping offline saved vendor shows toast, no sheet', async ({ page }) => {
  const vendor = await createNearbyVendor('help', 'Mechanic', 'saved-tap-offline');
  await seedSavedVendor(vendor);
  await supabaseAdmin.from('vendors').update({ is_active: false }).eq('id', vendor.id);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  const tile = page.getByRole('button').filter({ hasText: vendor.shop_name });
  await expect(tile).toBeVisible({ timeout: 15000 });
  await tile.click();
  await expect(
    page.locator('[data-sonner-toast]').getByText(L.vendorWentOffline, { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('parchi-sheet')).not.toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

// ─── SAVE/UNSAVE ───────────────────────────────────────────────────────────

test('RAD-11 — Unsave vendor removes from saved list', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'unsave');
  await seedSavedVendor(vendor);
  await gotoRadar(page, { q: 'grocery', mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await card.getByRole('button', { name: L.savedButton }).click();
  await expect
    .poll(async () => {
      const { count, error } = await supabaseAdmin
        .from('saved_vendors')
        .select('id', { count: 'exact', head: true })
        .eq('vendor_id', vendor.id)
        .eq('user_phone', CUSTOMER_PHONE);
      if (error) throw error;
      return count ?? 0;
    })
    .toBe(0);
});

// ─── ACTIVE ORDER BADGE ────────────────────────────────────────────────────

test('RAD-10 — Active order badge shows on vendor card', async ({ page }) => {
  const vendor = await createNearbyVendor('delivery', 'Grocery Store', 'active-order');
  await seedActiveOrder(vendor.id);
  await gotoRadar(page, { q: vendor.category, mode: 'delivery' });
  const card = vendorCard(page, vendor.shop_name);
  await expect(card).toBeVisible({ timeout: 25000 });
  await expect(card.getByText(L.orderSent, { exact: false })).toBeVisible();
});

// ─── AMBULANCE SEARCH ──────────────────────────────────────────────────────

test('RAD-06a — Search "ambulance" shows emergency panel, no vendor cards', async ({ page }) => {
  await createNearbyVendor('help', 'Mechanic', 'ambulance-noise');
  await gotoRadar(page, { q: 'ambulance' });
  await expect(page.getByText(L.govAmbulance)).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('radar-vendor-card')).not.toBeVisible();
});

// ─── SERVICE RADIUS ────────────────────────────────────────────────────────

test('RAD-RADIUS-01 — Vendor with tight radius (5km) hidden from customer 8km away', async ({
  page,
}) => {
  // Seed vendor at Pune centre (18.5204, 73.8567) with service_radius_km: 5
  const vendor = await createVendor('delivery', 'radrad01', {
    latitude: 18.5204,
    longitude: 73.8567,
    service_radius_km: 5,
  });
  // Customer is ~8km away
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.585, longitude: 73.8567 });
  await gotoRadarDelivery(page);
  await waitForScanComplete(page);
  const card = page.getByTestId('radar-vendor-card').filter({ hasText: vendor.shop_name });
  await expect(card).not.toBeVisible({ timeout: 5000 });
});

test('RAD-RADIUS-02 — Vendor with wide radius (50km) visible to customer 8km away', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'radrad02', {
    latitude: 18.5204,
    longitude: 73.8567,
    service_radius_km: 50,
  });
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.585, longitude: 73.8567 });
  await gotoRadarDelivery(page);
  await waitForScanComplete(page);
  await waitForVendorCard(page, vendor.shop_name);
});

test('RAD-RADIUS-03 — AI search respects vendor service radius', async ({ page }) => {
  // Vendor at 5km radius, customer 8km away, AI search for vendor category
  const vendor = await createVendor('delivery', 'radrad03', {
    latitude: 18.5204,
    longitude: 73.8567,
    service_radius_km: 5,
  });
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.585, longitude: 73.8567 });
  await gotoRadarDelivery(page);
  // Type a search term matching vendor category
  await page.getByTestId('radar-search-input').fill('grocery');
  await waitForScanComplete(page);
  const card = page.getByTestId('radar-vendor-card').filter({ hasText: vendor.shop_name });
  await expect(card).not.toBeVisible({ timeout: 5000 });
});
