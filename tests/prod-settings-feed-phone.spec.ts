/**
 * PROD verification: Local Feed under My Account + Settings phone add/change.
 * Run via: npx playwright test --config=playwright.prod-full.config.ts tests/prod-settings-feed-phone.spec.ts
 */
import { test, expect } from '@playwright/test';
import { getServiceRoleClient, getSupabaseUrl } from './helpers/testEnv';
import { loginAsCustomer, APP_URL, expandMyAccountAccordion } from './helpers/browser-setup';
import { mintBrowserSupabaseSession } from './helpers/setup';
import { strings } from '../src/lib/strings';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const CUSTOMER_PHONE = '9111000001';
const DEVICE_ID = 'prod-settings-verify-device';
const EN = strings.en;
const T = Date.now();

const ADD_PHONE = `9113${String(T).slice(-6)}`;
const EXISTING_PHONE = `9114${String(T).slice(-6)}`;

const probePhones = [ADD_PHONE, EXISTING_PHONE];
const probePostIds: string[] = [];

test.beforeAll(() => {
  const url = getSupabaseUrl();
  if (!url.includes(PROD_REF)) {
    throw new Error(`Refusing PROD settings verify — expected ${PROD_REF}, got ${url}`);
  }
  // eslint-disable-next-line no-console
  console.log(`PROD settings verify targeting ${url} APP_URL=${APP_URL}`);
});

test.afterAll(async () => {
  const admin = getServiceRoleClient();
  for (const id of probePostIds) {
    await admin.from('feed_posts').delete().eq('id', id);
  }
  for (const phone of probePhones) {
    await admin.from('feed_posts').delete().eq('user_phone', phone);
    await admin.from('user_devices').delete().eq('user_phone', phone);
    await admin.from('users').delete().eq('phone', phone);
  }
});

async function loginAsNoPhoneCustomer(page: import('@playwright/test').Page, deviceId: string) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((id) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('aaspaas:device_id', id);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, deviceId);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('first-open-flow')).not.toBeVisible();
}

test('PROD-SET-FEED-01 — Local Feed collapsible under MY ACCOUNT; radius saves on PROD', async ({
  page,
}) => {
  const admin = getServiceRoleClient();
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 15000 });

  // Sibling under MY ACCOUNT (parent starts closed) — expand, then body closed until tapped.
  await expandMyAccountAccordion(page);
  await expect(page.getByTestId('settings-feed-discovery-toggle')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('settings-feed-discovery')).not.toBeVisible();
  await expect(page.getByText(EN.nav_feed).first()).toBeVisible();

  await page.getByTestId('settings-feed-discovery-toggle').click();
  await expect(page.getByTestId('settings-feed-discovery')).toBeVisible();
  await expect(page.getByText(/Show me posts within/i)).toBeVisible();

  await page.getByRole('button', { name: /^10 km$/i }).click();
  await expect(page.getByText(/Feed discovery radius saved/i)).toBeVisible({ timeout: 15000 });

  const { data, error } = await admin.rpc('get_feed_preferences', {
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(error).toBeNull();
  expect((data as { feed_discovery_radius_km?: number | null } | null)?.feed_discovery_radius_km).toBe(
    10,
  );

  await page.getByTestId('settings-feed-discovery-toggle').click();
  await expect(page.getByTestId('settings-feed-discovery')).not.toBeVisible();

  // eslint-disable-next-line no-console
  console.log('PROD-SET-FEED-01 PASS: collapsible under My Account; radius=10 on PROD');
});

test('PROD-SET-PHONE-01 — no-phone customer adds phone from My Identity and posts to Local Feed', async ({
  page,
}) => {
  const admin = getServiceRoleClient();
  await loginAsNoPhoneCustomer(page, `${DEVICE_ID}-add-${T}`);
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });

  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByPlaceholder(/Share something with your neighbourhood/i)).toBeVisible({
    timeout: 8000,
  });
  await page.getByPlaceholder(/Share something with your neighbourhood/i).fill('Blocked without phone');
  await page.getByRole('button', { name: /^Post$/i }).click();
  await expect(page.getByText(/Add your phone in Settings first/i)).toBeVisible({ timeout: 8000 });

  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 10000 });
  await expandMyAccountAccordion(page);
  await page.getByTestId('settings-identity-toggle').click();
  await expect(page.getByTestId('settings-add-phone')).toBeVisible();
  await page.getByTestId('settings-add-phone').click();

  await expect(page.getByText(EN.phone_entry_settings_context)).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('98765 43210').fill(ADD_PHONE);
  await page.getByRole('button', { name: /^Continue$/i }).click();
  await expect(page.getByText(EN.settings_phoneSaved)).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(ADD_PHONE);
  await expect(page.getByTestId('settings-identity-phone')).toContainText(ADD_PHONE, {
    timeout: 8000,
  });
  await expect(page.getByTestId('settings-change-phone')).toBeVisible();

  await mintBrowserSupabaseSession(page, ADD_PHONE, 'PROD-SET-PHONE-01');
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(ADD_PHONE);

  await page.goto(`${APP_URL}/feed`);
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(ADD_PHONE);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByPlaceholder(/Share something with your neighbourhood/i)).toBeVisible({
    timeout: 8000,
  });
  const content = `PROD settings phone announce ${ADD_PHONE}`;
  await page.getByPlaceholder(/Share something with your neighbourhood/i).fill(content);
  await page.getByRole('button', { name: /^Post$/i }).click();
  await expect(page.getByText(/Posted!/i)).toBeVisible({ timeout: 20000 });

  const { data: posts, error } = await admin
    .from('feed_posts')
    .select('id, user_phone, content, type')
    .eq('user_phone', ADD_PHONE)
    .eq('type', 'announcement')
    .order('created_at', { ascending: false })
    .limit(1);
  expect(error).toBeNull();
  expect(posts?.length).toBeGreaterThan(0);
  expect(posts![0].content).toContain(content);
  probePostIds.push(posts![0].id);

  // eslint-disable-next-line no-console
  console.log('PROD-SET-PHONE-01 PASS: add phone from My Identity unlocked Local Feed post');
});

test('PROD-SET-PHONE-02 — My Identity offers restore for number with history', async ({ page }) => {
  const admin = getServiceRoleClient();
  await admin.from('users').upsert({
    phone: EXISTING_PHONE,
    total_orders: 5,
    completed_orders: 2,
  });

  await loginAsNoPhoneCustomer(page, `${DEVICE_ID}-exist-${T}`);
  await page.goto(`${APP_URL}/settings`);
  await expandMyAccountAccordion(page);
  await page.getByTestId('settings-identity-toggle').click();
  await page.getByTestId('settings-add-phone').click();
  await page.getByPlaceholder('98765 43210').fill(EXISTING_PHONE);
  await page.getByRole('button', { name: /^Continue$/i }).click();

  await expect(page.getByTestId('phone-entry-existing-title')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('phone-entry-existing-title')).toHaveText(
    EN.firstopen_existing_title,
  );
  await expect(page.getByTestId('phone-entry-existing-restore')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBeNull();

  await page.getByTestId('phone-entry-existing-restore').click();
  await expect(page.getByText(EN.settings_phoneSaved)).toBeVisible({ timeout: 15000 });
  expect(await page.evaluate(() => localStorage.getItem('aaspaas:user_phone'))).toBe(EXISTING_PHONE);

  // eslint-disable-next-line no-console
  console.log('PROD-SET-PHONE-02 PASS: existing-account restore offered from My Identity');
});
