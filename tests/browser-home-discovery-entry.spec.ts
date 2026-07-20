import { expect, test, type Page } from '@playwright/test';
import { APP_URL } from './helpers/browser-setup';
import {
  getActiveCategoryByLabel,
  seedVendorCategory,
  supabaseAdmin,
} from './helpers/setup';

const T = Date.now();
const ZERO_VENDOR_LABEL = `Zero Vendor ${T}`;
const DEVICE_ID = `home_entry_device_${T}`;
const CUSTOMER_PHONE = `881${String(T).slice(-7)}`;
const VENDOR_PHONE = `991${String(T + 1).slice(-7)}`;
let zeroVendorCategoryId = '';
let otpVendorId = '';

async function openOtpOffHome(page: Page, phone: string | null = null) {
  await page.goto(APP_URL);
  await page.evaluate(
    ({ deviceId, userPhone }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem('aaspaas:device_id', deviceId);
      localStorage.setItem('aaspaas:welcomed', 'true');
      if (userPhone) localStorage.setItem('aaspaas:user_phone', userPhone);
    },
    { deviceId: DEVICE_ID, userPhone: phone },
  );
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 20000 });
}

test.beforeAll(async () => {
  const { data: category, error: categoryError } = await supabaseAdmin
    .from('categories')
    .insert({
      label: ZERO_VENDOR_LABEL,
      emoji: '🫥',
      service_mode: 'help',
      is_active: true,
      pending_review: false,
      sort_order: 99999,
    })
    .select('id')
    .single();
  if (categoryError) throw categoryError;
  zeroVendorCategoryId = category.id;

  const plumber = await getActiveCategoryByLabel('Plumber');
  await supabaseAdmin.from('users').upsert(
    { phone: CUSTOMER_PHONE, trust_score: 75 },
    { onConflict: 'phone' },
  );
  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'OTP Off Home Owner',
      shop_name: `!OTP-OFF-HOME-${T}`,
      phone: VENDOR_PHONE,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      discoverable: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();
  if (vendorError) throw vendorError;
  otpVendorId = vendor.id;
  await seedVendorCategory(vendor.id, plumber, { is_primary: true });
  const { error: saveError } = await supabaseAdmin.from('saved_vendors').insert({
    user_phone: CUSTOMER_PHONE,
    device_id: DEVICE_ID,
    vendor_id: vendor.id,
    category: plumber.label,
    nickname: `!OTP-OFF-HOME-${T}`,
  });
  if (saveError) throw saveError;
});

test.afterAll(async () => {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .in('identifier', [CUSTOMER_PHONE, DEVICE_ID]);
  await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .delete()
    .eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('saved_vendors').delete().eq('vendor_id', otpVendorId);
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', otpVendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', otpVendorId);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('categories').delete().eq('id', zeroVendorCategoryId);
});

test('HDE-01 — Landing renders, shares the download link, and shows vendor registration copy', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => localStorage.setItem('landing-test-clipboard', value),
      },
    });
  });
  await page.goto(`${APP_URL}/landing`);

  await expect(page.getByRole('heading', { name: 'Aaspaas' })).toBeVisible();
  await expect(
    page.getByText('For vendors: Register your shop and get customers'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Download the App' }).click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('landing-test-clipboard')))
    .not.toBeNull();
  await expect(page.getByText('Link copied!')).toBeVisible();
});

test('HDE-02 — zero-vendor active category appears in Home and Picker; search, SOS, and selection work', async ({ page }) => {
  await openOtpOffHome(page);

  const homeCategory = page.getByTestId('home-category-button').filter({
    hasText: ZERO_VENDOR_LABEL,
  });
  await expect(homeCategory).toBeVisible({ timeout: 20000 });

  const search = page.getByRole('textbox');
  await search.fill('');
  await search.press('Enter');
  await expect(page.getByTestId('category-picker')).toBeVisible();
  await expect(
    page.getByTestId('category-picker-option').filter({ hasText: ZERO_VENDOR_LABEL }),
  ).toBeVisible();

  await page.getByTestId('category-picker').locator('button').first().click();
  await expect(page.getByTestId('category-picker')).not.toBeVisible();

  const beforeSosUrl = page.url();
  await page.getByTestId('home-sos-button').click();
  await expect(page.getByTestId('category-picker')).toBeVisible();
  expect(page.url()).toBe(beforeSosUrl);

  await page
    .getByTestId('category-picker-option')
    .filter({ hasText: ZERO_VENDOR_LABEL })
    .click();
  await expect(page).toHaveURL(/\/radar\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe(ZERO_VENDOR_LABEL);

  await openOtpOffHome(page);
  await page
    .getByTestId('home-category-button')
    .filter({ hasText: ZERO_VENDOR_LABEL })
    .click();
  await expect(page).toHaveURL(/\/radar\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe(ZERO_VENDOR_LABEL);
});

test('HDE-03 — genuine OTP-off Home has no Supabase session and can render and unsave a tile', async ({ page }) => {
  await openOtpOffHome(page, CUSTOMER_PHONE);

  const authKeys = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith('sb-') && key.endsWith('-auth-token')),
  );
  expect(authKeys).toEqual([]);

  const tile = page.getByTestId('saved-neighbour-tile');
  await expect(tile).toContainText(`!OTP-OFF-HOME-${T}`, { timeout: 20000 });
  await tile.click();
  await page.getByRole('button', { name: /Remove from My Neighbourhood/ }).click();
  await expect(tile).toHaveCount(0);

  await expect
    .poll(async () => {
      const { count } = await supabaseAdmin
        .from('saved_vendors')
        .select('id', { count: 'exact', head: true })
        .eq('user_phone', CUSTOMER_PHONE)
        .eq('vendor_id', otpVendorId);
      return count;
    })
    .toBe(0);
});
