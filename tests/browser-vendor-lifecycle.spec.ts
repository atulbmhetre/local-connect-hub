import { test, expect, Page } from '@playwright/test';
import {
  loginAsVendor,
  openVendorMyBusinessTab,
  expandFirstMyBusinessCategoryAccordion,
  APP_URL,
} from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  ensureVendorGoLivePhotos,
} from './helpers/setup';

const T = Date.now();
const DEVICE_ID = `device_vlife_${T}`;
const createdVendorIds: string[] = [];
let vendorPhoneSeq = 0;

function isAbsentVendorLoginRow(row: unknown): boolean {
  // SQL NULL composite → PostgREST null-filled object (id is null).
  return !row || typeof row !== 'object' || !(row as { id?: string | null }).id;
}

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99071${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createVendor(
  tag: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; phone: string; shop_name: string }> {
  const category = await getActiveCategoryByServiceMode('help');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Lifecycle ${tag}`,
      shop_name: `!Life-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: 'help',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: 'complete',
      service_radius_km: 9999,
      vendor_type: 'shop',
      base_type: 'shop',
      serves_at_vendor_place: true,
      serves_at_customer_place: true,
      discoverable: true,
      ...overrides,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ brand_name: `StaleBrand-${tag}` })
    .eq('vendor_id', vendor.id);
  createdVendorIds.push(vendor.id);
  return vendor;
}

test.afterAll(async () => {
  if (createdVendorIds.length === 0) return;
  await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
  await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
});

async function mockNativeCapacitor(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      CapacitorCustomPlatform?: { name: string; plugins: Record<string, unknown> };
      Capacitor?: { isNativePlatform: () => boolean; getPlatform: () => string };
    };
    w.CapacitorCustomPlatform = { name: 'android', plugins: {} };
    w.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
    };
  });
}

test('VL-01 — native 5-step onboarding when aaspaas:vendor_onboarded unset', async ({
  page,
}) => {
  const vendor = await createVendor('ONB');
  await mockNativeCapacitor(page);
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID, {
    skipOnboarding: false,
  });
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vendor-onboarding')).toBeVisible({ timeout: 20000 });

  for (let step = 1; step <= 4; step++) {
    await expect(page.getByTestId('vendor-onboarding-step')).toContainText(`${step} / 5`);
    const skip = page.getByTestId('vendor-onboarding-skip');
    if (await skip.isVisible()) {
      await skip.click();
    } else {
      await page.getByTestId('vendor-onboarding-action').click();
    }
  }
  await expect(page.getByTestId('vendor-onboarding-step')).toContainText('5 / 5');
  await page.getByTestId('vendor-onboarding-action').click();
  await expect(page.getByTestId('vendor-onboarding')).toHaveCount(0);
  const onboarded = await page.evaluate(() => localStorage.getItem('aaspaas:vendor_onboarded'));
  expect(onboarded).toBe('true');
});

test('VL-02 — Go Live help mode shows permission-denied help when GPS denied', async ({
  page,
}) => {
  const vendor = await createVendor('GPSDENY', { is_active: false, is_banned: false });
  // Photos gate runs before GPS; seed so the deny path can assert Location required.
  await ensureVendorGoLivePhotos(vendor.id);
  await page.addInitScript(() => {
    const err = Object.assign(new Error('User denied Geolocation'), { code: 1, PERMISSION_DENIED: 1 });
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (
          _success: PositionCallback,
          error?: PositionErrorCallback | null,
        ) => {
          if (error) error(err as GeolocationPositionError);
        },
        watchPosition: () => 0,
        clearWatch: () => undefined,
      },
    });
  });
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });

  await page.getByTestId('vendor-golive-btn').click();
  // Permission-denied path uses vendor_location_required toast + permission-denied body/help.
  await expect(page.getByText(/Location required to go live/i)).toBeVisible({
    timeout: 10000,
  });
  await expect(
    page
      .getByText(
        /Location permission is required|Mobile services need a fresh GPS/i,
      )
      .first(),
  ).toBeVisible({ timeout: 10000 });
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('is_active')
    .eq('id', vendor.id)
    .single();
  expect(data?.is_active).toBe(false);
});

test('VL-03 — phone lookup: unknown and banned share vendor_not_found UI; banned excluded by RPC', async ({
  page,
}) => {
  const banned = await createVendor('BANLOOKUP', { is_banned: true });
  const unknownPhone = nextVendorPhone();

  // RPC-level: banned phone returns SQL NULL (PostgREST may send a null-filled composite).
  const { data: bannedRow, error: bannedErr } = await supabase.rpc('get_vendor_by_phone_login', {
    p_phone: banned.phone,
  });
  expect(bannedErr).toBeNull();
  expect(isAbsentVendorLoginRow(bannedRow)).toBe(true);

  const { data: unknownRow, error: unknownErr } = await supabase.rpc('get_vendor_by_phone_login', {
    p_phone: unknownPhone,
  });
  expect(unknownErr).toBeNull();
  expect(isAbsentVendorLoginRow(unknownRow)).toBe(true);

  // UI: both produce the same not-found message.
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: /Already registered/i }).click();
  await expect(page.getByTestId('vendor-phone-lookup-form')).toBeVisible();

  await page.getByTestId('vendor-phone-lookup-input').fill(unknownPhone);
  await page.getByTestId('vendor-phone-lookup-submit').click();
  await expect(page.getByTestId('vendor-phone-lookup-error')).toBeVisible();
  const unknownMsg = (await page.getByTestId('vendor-phone-lookup-error').textContent())?.trim();

  await page.getByTestId('vendor-phone-lookup-input').fill(banned.phone);
  await page.getByTestId('vendor-phone-lookup-submit').click();
  await expect(page.getByTestId('vendor-phone-lookup-error')).toBeVisible();
  const bannedMsg = (await page.getByTestId('vendor-phone-lookup-error').textContent())?.trim();
  expect(bannedMsg).toBe(unknownMsg);
  expect(bannedMsg?.length).toBeGreaterThan(0);
});

test('VL-04 — Settings → My Business is ban-gated (suspension UI, no edit tabs)', async ({
  page,
}) => {
  const vendor = await createVendor('SETBAN', { is_banned: true });
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-vendor-banned')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('settings-vendor-tab-business')).toHaveCount(0);
  await expect(page.getByTestId('vendor-my-business')).toHaveCount(0);
});

test('VL-05 — Edit Shop Details shop_name keeps vendor_categories.brand_name in sync; no brand field UI', async ({
  page,
}) => {
  const vendor = await createVendor('BRANDSYNC');
  const { data: before } = await supabaseAdmin
    .from('vendor_categories')
    .select('brand_name')
    .eq('vendor_id', vendor.id)
    .single();
  expect(before?.brand_name).toContain('StaleBrand');

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'domcontentloaded' });
  await openVendorMyBusinessTab(page);
  await expandFirstMyBusinessCategoryAccordion(page);

  await expect(page.getByLabel(/Brand name for this category/i)).toHaveCount(0);
  await expect(page.getByLabel(/Brand \/ Trading Name/i)).toHaveCount(0);
  await expect(page.getByText(/Brand name for this category/i)).toHaveCount(0);

  const newShop = `!SyncedShop-${T}`;
  await page.getByTestId('my-business-shop-name').fill(newShop);
  await page.getByTestId('my-business-save').click();
  await expect(page.getByText(/saved|Saved|updated/i).first()).toBeVisible({ timeout: 15000 });

  const { data: after } = await supabaseAdmin
    .from('vendor_categories')
    .select('brand_name')
    .eq('vendor_id', vendor.id)
    .single();
  expect(after?.brand_name).toBe(newShop);

  // Defense in depth: vendor_update_own shop_name patch also syncs brand_name.
  const { error: ownErr } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { shop_name: `${newShop}-own` },
  });
  expect(ownErr).toBeNull();
  const { data: synced } = await supabaseAdmin
    .from('vendor_categories')
    .select('brand_name')
    .eq('vendor_id', vendor.id)
    .single();
  expect(synced?.brand_name).toBe(`${newShop}-own`);
});
