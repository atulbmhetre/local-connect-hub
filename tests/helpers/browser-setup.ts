import { expect, Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { loginAsCustomer, mintBrowserSupabaseSession } from './setup';

dotenv.config({ path: '.env.test' });

export const APP_URL = process.env.VITE_APP_URL || 'http://localhost:8080';
export const RADAR_DELIVERY_URL = `${APP_URL}/radar?mode=delivery`;

/** Radar with delivery mode selected (default /radar is help-only). */
export async function gotoRadarDelivery(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.goto(RADAR_DELIVERY_URL, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

/** Click Order on a delivery/booking radar card (falls back to first orderable card). */
export async function clickRadarOrderCard(
  page: Page,
  options?: { vendorId?: string; shopName?: string },
) {
  if (options?.vendorId) {
    const byId = page.locator(`#radar-vendor-card-${options.vendorId}`);
    if (await byId.isVisible({ timeout: 3000 }).catch(() => false)) {
      await byId.getByTestId('radar-vendor-card-order-btn').click();
      return;
    }
  }
  if (options?.shopName) {
    const shopNames = [options.shopName, options.shopName.replace(/^!/, '')];
    for (const name of shopNames) {
      const byShop = page.getByTestId('radar-vendor-card').filter({ hasText: name });
      if (await byShop.first().isVisible({ timeout: 5000 }).catch(() => false)) {
        await byShop.first().getByTestId('radar-vendor-card-order-btn').click();
        return;
      }
    }
  }
  const card = page.getByTestId('radar-vendor-card').filter({
    has: page.getByTestId('radar-vendor-card-order-btn'),
  }).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await card.getByTestId('radar-vendor-card-order-btn').click();
}

const ADMIN_PHONE_FALLBACK = '8888169446';

async function resolveAdminPhone(): Promise<string> {
  const supabase = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
  );
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'admin_phone')
    .maybeSingle();
  return data?.value?.trim() || ADMIN_PHONE_FALLBACK;
}

export { loginAsCustomer };

// Simulate a logged-in vendor
export async function loginAsVendor(page: Page, phone: string, vendorId: string, deviceId: string) {
  await page.goto(APP_URL);
  await page.evaluate(({ phone, vendorId, deviceId }) => {
    localStorage.setItem('aaspaas:user_phone', phone);
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:vendor_id', vendorId);
    localStorage.setItem('aaspaas:role', 'vendor');
    localStorage.setItem('aaspaas:welcomed', 'true');
    localStorage.setItem('aaspaas:vendor_onboarded', 'true');
  }, { phone, vendorId, deviceId });

  // Phase D: mint a real Supabase session so Phase C RLS policies work
  await mintBrowserSupabaseSession(page, phone, 'loginAsVendor');

  await page.reload();
  await page.waitForLoadState('networkidle');
}

// Admin user — phone must match app_config admin_phone (default 8888169446)
export async function loginAsAdmin(page: Page, deviceId = `admin_device_${Date.now()}`) {
  const phone = await resolveAdminPhone();
  await loginAsCustomer(page, phone, deviceId);
}

/** Wait for Settings app_config fetch so the admin tab can render after navigation. */
export async function waitForSettingsAdminReady(page: Page) {
  await page.getByTestId('settings-screen').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="settings-screen"]')
        ?.getAttribute('data-admin-config-loaded') === 'true',
    { timeout: 20000 },
  );
}

// Fresh user — no localStorage at all
export async function loginAsFreshUser(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.goto(APP_URL);
  await page.waitForSelector('[data-testid="first-open-flow"]', { timeout: 15000 });
}

// Clear session
export async function logout(page: Page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}
