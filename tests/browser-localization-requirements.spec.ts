import { readFileSync } from 'fs';
import { join } from 'path';
import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL, expandMyBusinessIdentityAccordion, openVendorMyBusinessTab, expandMyAccountAccordion } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  resolveRequestServiceMode,
} from './helpers/setup';
import { strings } from '../src/lib/strings';

const T = Date.now();
const CUSTOMER_PHONE = `88008${String(T).slice(-5)}`;
const DEVICE_ID = `device_loc_${T}`;

const EN = strings.en;
const HI = strings.hi;
const MR = strings.mr;

const CONFIG_KEYS = ['localization_enabled', 'lang_hindi_enabled', 'lang_marathi_enabled'] as const;
const originalConfig: Record<string, string> = {};

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

/** Raw i18n key leak: snake_case token like myOrders_delivered shown untranslated. */
const RAW_KEY_PATTERN = /\b[a-z][a-z0-9]*_[a-zA-Z0-9_]+\b/;

const DEVANAGARI = /[\u0900-\u097F]/;

async function snapshotAppConfig() {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('key, value')
    .in('key', [...CONFIG_KEYS]);
  for (const row of data ?? []) {
    if (!originalConfig[row.key]) originalConfig[row.key] = row.value;
  }
}

async function setAppConfig(key: (typeof CONFIG_KEYS)[number], value: string) {
  const { error } = await supabaseAdmin
    .from('app_config')
    .upsert({ key, value }, { onConflict: 'key' });
  if (error) throw error;
}

async function restoreAppConfig() {
  for (const key of CONFIG_KEYS) {
    if (originalConfig[key] !== undefined) {
      await setAppConfig(key, originalConfig[key]);
    }
  }
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99008${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createVendor(serviceMode: 'help' | 'delivery' | 'appointment', tag: string) {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `LOC Vendor ${tag}`,
      shop_name: `!LOC-${tag}-${T}`,
      phone: nextVendorPhone(),
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone, shop_name, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor!.id, category);
  createdVendorIds.push(vendor!.id);
  return vendor!;
}

async function seedRequest(
  vendorId: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const service_mode = await resolveRequestServiceMode(
    vendorId,
    typeof fields.service_mode === 'string' ? fields.service_mode : null,
  );
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'sent',
      ...fields,
      service_mode,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data!.id);
  return data!;
}

async function waitForHomeScreen(page: Page) {
  await page.waitForSelector('[data-testid="home-screen"]', { timeout: 20000 });
}

async function setLanguageLocalStorage(page: Page, lang: 'en' | 'hi' | 'mr') {
  await page.evaluate((l) => localStorage.setItem('aaspaas:language', l), lang);
}

async function hardReload(page: Page) {
  await page.reload({ waitUntil: 'networkidle' });
}

async function reloadAndGoHome(page: Page) {
  await page.goto(APP_URL);
  await waitForHomeScreen(page);
}

async function openPreferences(page: Page) {
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });
  await expandMyAccountAccordion(page);
  const prefsToggle = page.getByText(/preferences|प्राथमिक|प्राधान्य/i).first();
  await expect(prefsToggle).toBeVisible({ timeout: 8000 });
  await prefsToggle.click();
}

async function selectLanguage(page: Page, code: 'en' | 'hi' | 'mr') {
  await openPreferences(page);
  const langSelect = page.getByTestId('language-select');
  await expect(langSelect).toBeVisible({ timeout: 8000 });
  await langSelect.click();
  const label =
    code === 'en' ? /english/i : code === 'hi' ? /hindi|हिंदी/i : /marathi|मराठी/i;
  await page.getByRole('option', { name: label }).click();
  await reloadAndGoHome(page);
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
}

function orderCard(page: Page, message: string): Locator {
  return page.getByTestId('order-card').filter({ hasText: message });
}

async function openEditOrder(page: Page, message: string, s: typeof HI | typeof MR = HI) {
  await gotoMyOrders(page);
  const card = orderCard(page, message);
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.getByRole('button', { name: s.editOrder }).click();
  await expect(page.getByText(s.editOrder)).toBeVisible({ timeout: 8000 });
}

async function openRatingSheetForOrder(page: Page, message: string) {
  await gotoMyOrders(page);
  const card = orderCard(page, message);
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.getByTestId('order-rate-btn').click();
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 8000 });
}

async function loginCustomerFresh(page: Page) {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
}

test.beforeAll(async () => {
  await snapshotAppConfig();
  await seedCustomer();
});

test.afterAll(async () => {
  await restoreAppConfig();
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

// ─── FEATURE FLAG FALLBACK CHAIN ───────────────────────────────────────────

test.describe.configure({ mode: 'serial' });

test('LOC-REQ-01 — localization_enabled=false forces English regardless of selection', async ({
  page,
}) => {
  await setAppConfig('localization_enabled', 'false');
  await setAppConfig('lang_hindi_enabled', 'true');
  await setAppConfig('lang_marathi_enabled', 'true');

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await selectLanguage(page, 'hi');

  await expect(page.getByTestId('nav-home')).toHaveText(EN.nav_home);
  await expect(page.getByTestId('nav-home')).not.toHaveText(HI.nav_home);
});

test('LOC-REQ-02 — lang_hindi_enabled=false falls back to English when Hindi selected', async ({
  page,
}) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'false');
  await setAppConfig('lang_marathi_enabled', 'true');

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await openPreferences(page);

  await expect(page.getByRole('option', { name: /hindi|हिंदी/i })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await reloadAndGoHome(page);
  await expect(page.getByTestId('nav-home')).toHaveText(EN.nav_home);
});

test('LOC-REQ-03 — lang_marathi_enabled=false falls back to English when Marathi selected', async ({
  page,
}) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');
  await setAppConfig('lang_marathi_enabled', 'false');

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'mr');
  await openPreferences(page);

  await expect(page.getByRole('option', { name: /marathi|मराठी/i })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await reloadAndGoHome(page);
  await expect(page.getByTestId('nav-home')).toHaveText(EN.nav_home);
});

// ─── MY BUSINESS LABEL CASING ──────────────────────────────────────────────

test('LOC-REQ-04 — My Business label in Hindi renders without forced CSS uppercase breaking Devanagari', async ({
  page,
}) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');

  const vendor = await createVendor('delivery', 'shop04');
  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await setLanguageLocalStorage(page, 'hi');
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 8000 });

  const businessTab = page.getByTestId('settings-vendor-tab-business');
  await expect(businessTab).toBeVisible({ timeout: 8000 });
  const tabText = (await businessTab.textContent())?.trim() ?? '';
  expect(tabText.length).toBeGreaterThan(0);
  expect(tabText).toMatch(DEVANAGARI);
  const tabTransform = await businessTab.evaluate((el) => getComputedStyle(el).textTransform);
  expect(tabTransform).not.toBe('uppercase');

  await openVendorMyBusinessTab(page);
  await expandMyBusinessIdentityAccordion(page);
  const identityToggle = page.getByTestId('my-business-identity-accordion-toggle');
  const identityLabel = identityToggle.locator('p').first();
  const labelText = (await identityLabel.textContent())?.trim() ?? '';
  expect(labelText).toMatch(DEVANAGARI);
  const textTransform = await identityLabel.evaluate((el) => getComputedStyle(el).textTransform);
  expect(textTransform).not.toBe('uppercase');
});

// ─── SPECIFIC STRING CORRECTNESS ───────────────────────────────────────────

test('LOC-REQ-05 — Hindi: myOrders_delivered says "rate" not "dismiss"', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');

  const vendor = await createVendor('delivery', 'del05');
  const msg = `LOC-REQ-05-${T}`;
  await seedRequest(vendor.id, msg, { status: 'fulfilled' });

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await reloadAndGoHome(page);

  await gotoMyOrders(page);
  const rateBtn = orderCard(page, msg).getByTestId('order-rate-btn');
  await expect(rateBtn).toBeVisible({ timeout: 15000 });
  await expect(rateBtn).toHaveText(HI.myOrders_delivered);
  await expect(rateBtn).not.toHaveText(HI.myOrders_dismiss);
  const btnText = (await rateBtn.textContent()) ?? '';
  expect(btnText).toMatch(/रेट/i);
  expect(btnText).not.toMatch(/हटाएं|खारिज/i);
});

test('LOC-REQ-06 — Marathi: rating_btnHelped is gender-neutral', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_marathi_enabled', 'true');

  const vendor = await createVendor('help', 'help06');
  const msg = `LOC-REQ-06-${T}`;
  await seedRequest(vendor.id, msg, { status: 'fulfilled' });

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'mr');
  await reloadAndGoHome(page);

  await openRatingSheetForOrder(page, msg);
  await page.getByTestId('rating-star-4').click();
  const submit = page.getByTestId('rating-submit-btn');
  await expect(submit).toHaveText(MR.rating_btnHelped);
  await expect(submit).toContainText('विक्रेत्याने');
  const btnText = (await submit.textContent()) ?? '';
  expect(btnText).not.toMatch(/^✅\s*त्याने\s/);
});

test('LOC-REQ-07 — Hindi: rating_btnHelped is gender-neutral', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');

  const vendor = await createVendor('help', 'help07');
  const msg = `LOC-REQ-07-${T}`;
  await seedRequest(vendor.id, msg, { status: 'fulfilled' });

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await reloadAndGoHome(page);

  await openRatingSheetForOrder(page, msg);
  await page.getByTestId('rating-star-4').click();
  const submit = page.getByTestId('rating-submit-btn');
  await expect(submit).toHaveText(HI.rating_btnHelped);
  await expect(submit).toContainText('विक्रेता');
  await expect(submit).not.toContainText('उसने');
});

test('LOC-REQ-08 — Hindi: edit order textarea placeholder localized', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');

  const vendor = await createVendor('delivery', 'edit08');
  const msg = `LOC-REQ-08-${T}`;
  await seedRequest(vendor.id, msg, { status: 'seen' });

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await reloadAndGoHome(page);

  await openEditOrder(page, msg);
  const textarea = page.getByPlaceholder(HI.editOrder_messagePlaceholder);
  await expect(textarea).toBeVisible({ timeout: 8000 });
  await expect(textarea).not.toHaveAttribute('placeholder', EN.editOrder_messagePlaceholder);
});

test('LOC-REQ-09 — Marathi: edit order textarea placeholder localized', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_marathi_enabled', 'true');

  const vendor = await createVendor('delivery', 'edit09');
  const msg = `LOC-REQ-09-${T}`;
  await seedRequest(vendor.id, msg, { status: 'seen' });

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'mr');
  await reloadAndGoHome(page);

  await openEditOrder(page, msg, MR);
  const textarea = page.getByPlaceholder(MR.editOrder_messagePlaceholder);
  await expect(textarea).toBeVisible({ timeout: 8000 });
  await expect(textarea).not.toHaveAttribute('placeholder', EN.editOrder_messagePlaceholder);
});

// ─── RAW KEY LEAK DETECTION ────────────────────────────────────────────────

test('LOC-REQ-10 — No raw string keys visible anywhere on My Orders in Hindi', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_hindi_enabled', 'true');

  const delivery = await createVendor('delivery', 'mo10d');
  const booking = await createVendor('appointment', 'mo10b');
  const help = await createVendor('help', 'mo10h');

  const seeds: Array<[string, Record<string, unknown>]> = [
    ['sent', { status: 'sent' }],
    ['accepted', { status: 'accepted' }],
    ['fulfilled', { status: 'fulfilled' }],
  ];

  for (const [state, fields] of seeds) {
    await seedRequest(delivery.id, `LOC10-d-${state}-${T}`, fields);
    await seedRequest(booking.id, `LOC10-b-${state}-${T}`, {
      ...fields,
      appointment_time: new Date(Date.now() + 7 * 86400000).toISOString(),
      appointment_status: state === 'accepted' ? 'confirmed' : 'pending',
    });
    await seedRequest(help.id, `LOC10-h-${state}-${T}`, fields);
  }

  await loginCustomerFresh(page);
  await setLanguageLocalStorage(page, 'hi');
  await reloadAndGoHome(page);

  await gotoMyOrders(page);
  const content = (await page.getByTestId('my-orders-screen').textContent()) ?? '';
  const leaks = content.match(new RegExp(RAW_KEY_PATTERN, 'g')) ?? [];
  expect(leaks, `Raw keys found: ${leaks.join(', ')}`).toEqual([]);
});

test('LOC-REQ-11 — No raw string keys visible on Incoming Orders in Marathi', async ({ page }) => {
  await setAppConfig('localization_enabled', 'true');
  await setAppConfig('lang_marathi_enabled', 'true');

  const vendor = await createVendor('help', 'inc11');
  await seedRequest(vendor.id, `LOC-REQ-11-${T}`, { status: 'sent' });

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await setLanguageLocalStorage(page, 'mr');
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('incoming-order-card').first()).toBeVisible({ timeout: 15000 });

  const section = page.locator('#vendor-incoming-orders');
  const content = (await section.textContent()) ?? '';
  const leaks = content.match(new RegExp(RAW_KEY_PATTERN, 'g')) ?? [];
  expect(leaks, `Raw keys found: ${leaks.join(', ')}`).toEqual([]);
});

// ─── VOICE UNAVAILABLE STRING (source-only; native UI not testable in browser) ─

test('LOC-REQ-12 — rating_voiceUnavailable has correct HI/MR translations in source (voice UI is native-only, cannot test via browser)', () => {
  const source = readFileSync(join(process.cwd(), 'src/lib/strings.ts'), 'utf8');
  const matches = [...source.matchAll(/rating_voiceUnavailable:\s*'([^']*)'/g)].map((m) => m[1]);
  expect(matches.length).toBeGreaterThanOrEqual(3);

  const [enVal, hiVal, mrVal] = matches;
  expect(enVal.length).toBeGreaterThan(0);
  expect(hiVal.length).toBeGreaterThan(0);
  expect(mrVal.length).toBeGreaterThan(0);

  expect(hiVal).toMatch(DEVANAGARI);
  expect(mrVal).toMatch(DEVANAGARI);
  expect(hiVal).not.toBe(enVal);
  expect(mrVal).not.toBe(enVal);
});
