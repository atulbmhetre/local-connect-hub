/**
 * PROD wizard smoke — production Vite build + PROD Supabase.
 * Start: npm run build:prod && npx vite preview --port 4173 --host 127.0.0.1
 * Run: npx dotenv -e .env.test.prod -o -- playwright test tests/prod-vendor-wizard-smoke.spec.ts --config=playwright.prod-smoke.config.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

const APP = 'http://127.0.0.1:4173';
const PROD_CATEGORY = 'Cook';

async function mockGeo(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function openWizard(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP}/vendor`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder('Ramesh Kumar')).toBeVisible({ timeout: 20000 });
}

async function pickCategory(page: Page, categoryLabel: string) {
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = page.getByRole('button', { name: new RegExp(categoryLabel, 'i') });
  await expect(chip.first()).toBeVisible({ timeout: 20000 });
  await chip.first().click();
}

async function captureGps(page: Page) {
  const btn = page.getByRole('button', {
    name: /📍 Capture Shop Location|📍 दुकान|Location set/i,
  });
  await expect(btn).toBeVisible({ timeout: 10000 });
  if (!(await btn.textContent())?.includes('Location set')) {
    await btn.click();
  }
  await expect(btn).toContainText(/Location set|लोकेशन सेट/, { timeout: 10000 });
}

async function page1Common(
  page: Page,
  ownerName: string,
  categoryLabel: string,
  opts: { base: 'shop' | 'home' | 'none'; shopName?: string },
) {
  await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
  await pickCategory(page, categoryLabel);
  const baseLabel =
    opts.base === 'shop'
      ? /Shop|दुकान/
      : opts.base === 'home'
        ? /Home|घर/
        : /No fixed place|fixed जगह नाही|कोई fixed/;
  await page.locator('button').filter({ hasText: baseLabel }).first().click();
  if (opts.base === 'shop' && opts.shopName) {
    await page.getByPlaceholder('Ramesh Tyre Works').fill(opts.shopName);
    await captureGps(page);
  } else if (opts.base === 'home') {
    if (opts.shopName) {
      await page.getByPlaceholder('e.g. Ramesh Home Kitchen').fill(opts.shopName);
    }
    await captureGps(page);
  } else {
    await page.waitForTimeout(2000);
  }
}

async function page2Reach(page: Page, reach: 'vendor' | 'both' | 'customer', modes: Array<'help' | 'delivery' | 'appointment'>) {
  if (reach === 'customer') {
    await page.getByRole('button', { name: /At their place|उनके पास/ }).click();
  } else if (reach === 'both') {
    await page.getByRole('button', { name: /Both.*Shop visits|दोनों|दोन्ही/ }).click();
  } else {
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  }
  if (reach !== 'vendor') {
    await page.getByRole('button', { name: '15 km' }).click();
  }
  for (const mode of modes) {
    const label =
      mode === 'help' ? /Urgent help|तुरंत/ : mode === 'delivery' ? /Delivery|डिलीवरी/ : /Appointments|अपॉइंटमेंट/;
    await page.getByRole('button', { name: label }).click();
  }
  await page.getByRole('button', { name: 'Next' }).click();
}

async function page3Register(page: Page, phone: string) {
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
  await page.getByPlaceholder('name@okbank').fill('prod-smoke@upi');
  await page.getByRole('button', { name: 'Register me' }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 25000 });
}

async function deleteVendor(phone: string) {
  const { data } = await supabaseAdmin.from('vendors').select('id').eq('phone', phone).maybeSingle();
  if (!data?.id) return;
  await supabaseAdmin.from('vendor_availability_modes').delete().eq('vendor_id', data.id);
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', data.id);
  await supabaseAdmin.from('vendors').delete().eq('id', data.id);
}

async function expectGuidanceToast(page: Page, pattern: RegExp) {
  const sonner = page.locator('[data-sonner-toast], [data-sonner-toaster] li').filter({ hasText: pattern });
  await expect(sonner.first()).toBeVisible({ timeout: 5000 });
}

test.describe('PROD wizard smoke @ prod-build', () => {
  test('shop + vendor-place only', async ({ page }) => {
    const phone = `99101${Date.now().toString().slice(-5)}`;
    await mockGeo(page);
    await openWizard(page);
    await page1Common(page, 'Smoke Shop Owner', PROD_CATEGORY, {
      base: 'shop',
      shopName: `Smoke Shop ${phone.slice(-4)}`,
    });
    await page.getByRole('button', { name: 'Next' }).click();
    await page2Reach(page, 'vendor', ['help']);
    await page3Register(page, phone);
    const { data } = await supabaseAdmin
      .from('vendors')
      .select('base_type, serves_at_vendor_place, serves_at_customer_place')
      .eq('phone', phone)
      .single();
    expect(data?.base_type).toBe('shop');
    expect(data?.serves_at_vendor_place).toBe(true);
    expect(data?.serves_at_customer_place).toBe(false);
    await deleteVendor(phone);
  });

  test('home + both reach', async ({ page }) => {
    const phone = `99102${Date.now().toString().slice(-5)}`;
    await mockGeo(page);
    await openWizard(page);
    await page1Common(page, 'Smoke Home Owner', PROD_CATEGORY, { base: 'home', shopName: 'Home Brand' });
    await page.getByRole('button', { name: 'Next' }).click();
    await page2Reach(page, 'both', ['help']);
    await page3Register(page, phone);
    const { data } = await supabaseAdmin
      .from('vendors')
      .select('base_type, serves_at_vendor_place, serves_at_customer_place')
      .eq('phone', phone)
      .single();
    expect(data?.base_type).toBe('home');
    expect(data?.serves_at_vendor_place).toBe(true);
    expect(data?.serves_at_customer_place).toBe(true);
    await deleteVendor(phone);
  });

  test('none + customer-place (silent GPS)', async ({ page }) => {
    const phone = `99103${Date.now().toString().slice(-5)}`;
    await mockGeo(page);
    await openWizard(page);
    await page1Common(page, 'Smoke Mobile Owner', PROD_CATEGORY, { base: 'none' });
    await page.getByRole('button', { name: 'Next' }).click();
    await page2Reach(page, 'customer', ['help']);
    await page3Register(page, phone);
    const { data } = await supabaseAdmin
      .from('vendors')
      .select('base_type, serves_at_vendor_place, serves_at_customer_place, latitude, longitude')
      .eq('phone', phone)
      .single();
    expect(data?.base_type).toBe('none');
    expect(data?.serves_at_vendor_place).toBe(false);
    expect(data?.serves_at_customer_place).toBe(true);
    expect(data?.latitude).not.toBeNull();
    await deleteVendor(phone);
  });

  test('guidance toasts block Next on missing fields', async ({ page }) => {
    await mockGeo(page);
    await openWizard(page);

    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Choose where you work from/i);
    await expect(page.getByPlaceholder('Ramesh Kumar')).toBeVisible();

    await page.getByPlaceholder('Ramesh Kumar').fill('Smoke Guidance');
    await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /shop name/i);

    await page.getByPlaceholder('Ramesh Tyre Works').fill('Guidance Shop');
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Select at least one category/i);

    await pickCategory(page, PROD_CATEGORY);
    await page.getByRole('button', { name: /📍 Capture Shop Location|📍 दुकान/i }).click();
    await expect(page.getByRole('button', { name: /Location set/i })).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/Customer reach|At my place/i).first()).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /where customers can reach you/i);
  });

  test('help + appointment multi-select persists', async ({ page }) => {
    const phone = `99104${Date.now().toString().slice(-5)}`;
    await mockGeo(page);
    await openWizard(page);
    await page1Common(page, 'Multi Mode Owner', PROD_CATEGORY, {
      base: 'shop',
      shopName: `Multi ${phone.slice(-4)}`,
    });
    await page.getByRole('button', { name: 'Next' }).click();
    await page2Reach(page, 'vendor', ['help', 'appointment']);
    await page3Register(page, phone);
    const { data: v } = await supabaseAdmin.from('vendors').select('id').eq('phone', phone).single();
    const { data: modes } = await supabaseAdmin
      .from('vendor_availability_modes')
      .select('mode')
      .eq('vendor_id', v!.id);
    const sorted = (modes ?? []).map((m) => m.mode).sort();
    expect(sorted).toEqual(['appointment', 'help']);
    await deleteVendor(phone);
  });
});
