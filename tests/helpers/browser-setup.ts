import { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

export const APP_URL = process.env.VITE_APP_URL || 'http://localhost:8080';

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

// Simulate a logged-in customer
export async function loginAsCustomer(page: Page, phone: string, deviceId: string) {
  await page.goto(APP_URL);
  await page.evaluate(({ phone, deviceId }) => {
    localStorage.setItem('aaspaas:user_phone', phone);
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:role', 'customer');
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { phone, deviceId });
  await page.reload();
  await page.waitForLoadState('networkidle');
}

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
  await page.waitForLoadState('networkidle');
  await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="settings-screen"]')
          ?.getAttribute('data-admin-config-loaded') === 'true',
      { timeout: 10000 },
    )
    .catch(() => {});
  await page.waitForTimeout(500);
}

// Fresh user — no localStorage at all
export async function loginAsFreshUser(page: Page) {
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForLoadState('networkidle');
}

// Clear session
export async function logout(page: Page) {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}
