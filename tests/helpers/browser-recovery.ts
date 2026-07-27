import { expect, type Page } from '@playwright/test';
import { gotoRadarDelivery, clickRadarOrderCard } from './browser-setup';
import { mintBrowserSupabaseSession } from './setup';

export async function dismissWelcomeIfVisible(page: Page) {
  const flow = page.getByTestId('first-open-flow');
  if (!(await flow.isVisible().catch(() => false))) return;

  const imNew = page.getByTestId('firstopen-im-new');
  if (await imNew.isVisible().catch(() => false)) {
    await imNew.click();
  }
  const useAsCustomer = page.getByTestId('firstopen-use-as-customer');
  if (await useAsCustomer.isVisible().catch(() => false)) {
    await useAsCustomer.click();
  }
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible({ timeout: 5000 });
}

/** Opens Parchi and triggers phone entry (fresh user, no phone in localStorage). */
export async function openPhoneEntrySheet(
  page: Page,
  options?: { shopName?: string; vendorId?: string; deviceId?: string },
) {
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await gotoRadarDelivery(page);
  // URL mode can race with RadarSearch defaulting to help — pin delivery explicitly.
  await page.getByTestId('radar-mode-delivery').click();
  if (options?.deviceId) {
    await page.evaluate((deviceId) => {
      localStorage.setItem('aaspaas:device_id', deviceId);
      localStorage.setItem('aaspaas:welcomed', 'true');
    }, options.deviceId);
  }
  await dismissWelcomeIfVisible(page);

  await clickRadarOrderCard(page, options);
  await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('parchi-message-input').fill('Browser recovery test order');

  const savedAddress = page.getByTestId('parchi-sheet').locator('button').filter({
    hasText: /Recovery Lane|Test Flat/i,
  });
  if (await savedAddress.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await savedAddress.first().click();
  } else {
    const addressInput = page.getByTestId('parchi-address-input');
    await expect(addressInput).toBeVisible({ timeout: 8000 });
    await addressInput.fill('Test Flat 4B, Recovery Lane');
  }

  await page.getByTestId('parchi-submit-btn').click();
  await expect(page.getByText('Enter your mobile number')).toBeVisible({ timeout: 20000 });
}

export async function submitPhoneNumber(page: Page, phone: string) {
  const digits = phone.replace(/\D/g, '').slice(0, 10);
  const input = page.getByPlaceholder('98765 43210');
  await input.fill(digits);
  const sessionReady = await page.evaluate(async (expectedPhone) => {
    try {
      const { supabase } = await import('/src/lib/supabase.ts');
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) return false;
      const raw = session.user?.phone ?? '';
      const cleaned = raw.replace(/\D/g, '');
      const sessionPhone =
        cleaned.length === 12 && cleaned.startsWith('91') ? cleaned.slice(2) : cleaned;
      return sessionPhone === expectedPhone;
    } catch {
      return false;
    }
  }, digits);
  if (!sessionReady) {
    await mintBrowserSupabaseSession(page, digits, 'submitPhoneNumber');
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Checking...').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}
