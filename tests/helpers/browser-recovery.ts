import { expect, type Page } from '@playwright/test';
import { APP_URL } from './browser-setup';

export async function dismissWelcomeIfVisible(page: Page) {
  const explore = page.getByTestId('welcome-explore-btn');
  if (await explore.isVisible().catch(() => false)) {
    await explore.click();
    await expect(page.getByTestId('welcome-card')).not.toBeVisible({ timeout: 5000 });
  }
}

/** Opens Parchi and triggers phone entry (fresh user, no phone in localStorage). */
export async function openPhoneEntrySheet(page: Page) {
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar`);
  await page.waitForLoadState('networkidle');
  await dismissWelcomeIfVisible(page);

  await expect(page.getByTestId('radar-vendor-card').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('radar-vendor-card-order-btn').first().click();
  await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 8000 });
  await page.getByTestId('parchi-message-input').fill('Browser recovery test order');

  const addressInput = page.getByPlaceholder('e.g. Flat 4B, Green Park, Near Water Tank');
  if (await addressInput.isVisible().catch(() => false)) {
    await addressInput.fill('Test Flat 4B, Recovery Lane');
  }

  await page.getByTestId('parchi-submit-btn').click();
  await expect(page.getByText('Enter your mobile number')).toBeVisible({ timeout: 10000 });
}

export async function submitPhoneNumber(page: Page, phone: string) {
  const digits = phone.replace(/\D/g, '').slice(0, 10);
  const input = page.getByPlaceholder('98765 43210');
  await input.fill(digits);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Checking...').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
}
