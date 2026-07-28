/**
 * Settings permissions + app-lifecycle (device UX).
 *
 * DEVICE-TEST CHECKLIST (real Android OS — Playwright cannot drive these):
 * DTC-PERM-01 — Grant Camera in Settings → ✅. Revoke via Android Settings →
 *   Apps → AasPaas Pro → Permissions while app is backgrounded → resume app on
 *   Settings → Device section shows Allow again (live OS read, not cached).
 * DTC-PERM-02 — Tap Camera Allow → dismiss OS dialog without granting → row
 *   stays Allow (never ✅). Only after OS callback returns granted → ✅.
 * DTC-PERM-03 — Clear All Data dialog copy mentions Camera/Mic/Location/
 *   Notifications are Android-managed and not cleared by this action.
 * DTC-PERM-04 — After Clear All Data + fresh "I'm new" flow, open Settings →
 *   Device: badges match true OS state (granted only if OS still has grant;
 *   no stale app ticks when OS is denied/prompt).
 * DTC-PERM-05 — While on /settings (or /radar, /vendor), background + resume:
 *   stay on the same route; permission badges refresh if Device section is open.
 *   Must NOT hard-reset navigation to Home.
 * DTC-RESUME-01 — Native: background from /radar, resume → still /radar (not Home).
 * DTC-RESUME-02 — Native: background from /vendor, resume → still /vendor (not Home).
 *
 * Automated coverage below is copy/smoke + web visibilitychange resume simulation.
 * Native appStateChange resume is covered by DTC-RESUME-* on device.
 */
import { test, expect, type Page } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import { createTestVendor } from './helpers/setup';
import { strings } from '../src/lib/strings';

const T = Date.now();
const PHONE = `88009${String(T).slice(-5)}`;
const VENDOR_PHONE = `99009${String(T).slice(-5)}`;
const DEVICE_ID = `device_perm_${T}`;
const VENDOR_DEVICE_ID = `device_perm_vendor_${T}`;

/** Web resume simulation — matches Radar visibilitychange + Settings web fallback. */
async function simulateForegroundResume(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

async function gotoRadarHelp(page: Page, q: string) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.goto(`${APP_URL}/radar?q=${encodeURIComponent(q)}&mode=help`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

test('PERM-COPY-01 — Clear All Data dialog states OS permissions are not cleared', async ({
  page,
}) => {
  await loginAsCustomer(page, PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`, { waitUntil: 'domcontentloaded' });

  const clearBtn = page.getByRole('button', { name: strings.en.settings_clearMyData });
  await expect(clearBtn).toBeVisible({ timeout: 15000 });
  await clearBtn.click();

  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 8000 });
  await expect(dialog).toContainText(/not cleared here/i);
  await expect(dialog).toContainText(/Camera, microphone, location, and notification permissions/i);
  await expect(dialog).toContainText(/Android/i);
});

test('RESUME-01 — Radar stays on /radar after simulated background → foreground', async ({
  page,
}) => {
  await loginAsCustomer(page, PHONE, DEVICE_ID);
  await gotoRadarHelp(page, 'mikanik');

  await expect(page).toHaveURL(/\/radar\?.*q=mikanik/);
  await expect(page.getByTestId('radar-search-input')).toHaveValue('mikanik');

  await simulateForegroundResume(page);

  await expect(page).toHaveURL(/\/radar\?.*q=mikanik/);
  await expect(page.getByTestId('radar-search-input')).toBeVisible();
  await expect(page.getByTestId('radar-search-input')).toHaveValue('mikanik');
  await expect(page.getByTestId('home-screen')).not.toBeVisible();
});

test('RESUME-02 — VendorMode stays on /vendor after simulated background → foreground', async ({
  page,
}) => {
  const vendor = await createTestVendor({
    phone: VENDOR_PHONE,
    is_active: true,
    profile_status: 'complete',
  });

  await loginAsVendor(page, VENDOR_PHONE, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 15000 });
  await expect(page).toHaveURL(/\/vendor/);

  await simulateForegroundResume(page);

  await expect(page).toHaveURL(/\/vendor/);
  await expect(page.getByTestId('vendor-screen')).toBeVisible();
  await expect(page.getByTestId('home-screen')).not.toBeVisible();
});
