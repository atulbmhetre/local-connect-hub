import { Page } from '@playwright/test';

export const APP_URL = process.env.VITE_APP_URL || 'http://localhost:8080';

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
  await loginAsCustomer(page, '8888169446', deviceId);
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
