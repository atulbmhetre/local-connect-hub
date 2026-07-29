/**
 * PROD wizard smoke — production Vite build + PROD Supabase.
 * Prefer: npx playwright test --config=playwright.prod-smoke.config.ts
 * (config auto-runs build:prod + vite preview on :4173).
 * Manual: npm run build:prod && npx vite preview --port 4173 --host 127.0.0.1
 */
import { test, expect, type Page } from '@playwright/test';
import { supabaseAdmin } from './helpers/setup';

const APP = 'http://127.0.0.1:4173';
const PROD_CATEGORY = 'Cook';

async function mockGeo(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function openWizard(page: Page) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP}/vendor`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder('Ramesh Kumar')).toBeVisible({ timeout: 20000 });
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

/** Step A: account (name, phone, UPI, base, GPS, selfie). */
async function completeWizardStepA(
  page: Page,
  opts: {
    ownerName: string;
    phone: string;
    upi?: string;
    base?: 'shop' | 'home' | 'none';
  },
) {
  const base = opts.base ?? 'shop';
  await page.getByPlaceholder('Ramesh Kumar').fill(opts.ownerName);
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(opts.phone);
  await page.getByPlaceholder('name@okbank').fill(opts.upi ?? 'prod-smoke@upi');
  const baseLabel =
    base === 'shop'
      ? /Shop|दुकान/
      : base === 'home'
        ? /Home|घर/
        : /No fixed place|fixed जगह नाही|कोई fixed/;
  await page.locator('button').filter({ hasText: baseLabel }).first().click();
  if (base !== 'none') {
    await captureGps(page);
  } else {
    await page.waitForTimeout(2000);
  }
  await page.getByTestId('reg-selfie-capture').click();
  await page.waitForTimeout(800);
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('button', { name: 'Next' }).click();
}

/** Step B: single business + shop photo → Register. */
async function completeWizardStepB(
  page: Page,
  opts: {
    categoryLabel: string;
    brandName?: string;
    reach?: 'customer' | 'vendor' | 'both';
    modes: Array<'help' | 'delivery' | 'appointment'>;
    pickRadius?: boolean;
  },
) {
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = page.getByRole('button', { name: new RegExp(opts.categoryLabel, 'i') });
  await expect(chip.first()).toBeVisible({ timeout: 20000 });
  await chip.first().click();
  // Shop base requires shop name; home/none use optional brand field.
  const brand = opts.brandName ?? `Smoke Shop ${Date.now().toString().slice(-4)}`;
  const shopInput = page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i);
  await expect(shopInput).toBeVisible({ timeout: 5000 });
  await shopInput.fill(brand);
  await expect(shopInput).toHaveValue(brand);
  const reach = opts.reach ?? 'vendor';
  if (reach === 'customer') {
    await page.getByRole('button', { name: /At their place/ }).click();
  } else if (reach === 'both') {
    await page.getByRole('button', { name: /Both/ }).filter({ hasText: /Shop visits|दोनों|दोन्ही|^Both$/ }).click();
  } else {
    await page.getByRole('button', { name: /At my place/ }).click();
  }
  const needRadius = opts.pickRadius ?? (reach === 'customer' || reach === 'both');
  if (needRadius) {
    await page.getByRole('button', { name: '15 km' }).click();
  }
  // Uniselect: only the last selected mode is kept.
  if (opts.modes.length > 0) {
    const mode = opts.modes[opts.modes.length - 1];
    await page.getByTestId(`reg-avail-${mode}`).click();
  }
  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी/i })).toBeEnabled({
    timeout: 10000,
  });
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी/i }).click();
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
    await enableE2eCameraMock(page);
    await openWizard(page);
    await completeWizardStepA(page, {
      ownerName: 'Smoke Shop Owner',
      phone,
      base: 'shop',
    });
    await completeWizardStepB(page, {
      categoryLabel: PROD_CATEGORY,
      brandName: `Smoke Shop ${phone.slice(-4)}`,
      reach: 'vendor',
      modes: ['help'],
    });
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
    await enableE2eCameraMock(page);
    await openWizard(page);
    await completeWizardStepA(page, {
      ownerName: 'Smoke Home Owner',
      phone,
      base: 'home',
    });
    await completeWizardStepB(page, {
      categoryLabel: PROD_CATEGORY,
      brandName: 'Home Brand',
      reach: 'both',
      modes: ['help'],
    });
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
    await enableE2eCameraMock(page);
    await openWizard(page);
    await completeWizardStepA(page, {
      ownerName: 'Smoke Mobile Owner',
      phone,
      base: 'none',
    });
    await completeWizardStepB(page, {
      categoryLabel: PROD_CATEGORY,
      brandName: 'Mobile Brand',
      reach: 'customer',
      modes: ['help'],
    });
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
    await enableE2eCameraMock(page);
    await openWizard(page);

    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Choose where you work from/i);
    await expect(page.getByPlaceholder('Ramesh Kumar')).toBeVisible();

    await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Enter your name/i);

    await page.getByPlaceholder('Ramesh Kumar').fill('Smoke Guidance');
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /10-digit|mobile|phone/i);

    await page.getByPlaceholder('+91 98xxxxxxxx').fill('9910999999');
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /UPI|upi/i);

    await page.getByPlaceholder('name@okbank').fill('guidance@upi');
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Confirm your location|GPS is required/i);

    await captureGps(page);
    await page.getByRole('button', { name: 'Next' }).click();
    await expectGuidanceToast(page, /Take selfie|selfie/i);

    await page.getByTestId('reg-selfie-capture').click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText(/Customer reach|At my place|Browse all categories/i).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('availability mode uniselect persists (last selection wins)', async ({ page }) => {
    const phone = `99104${Date.now().toString().slice(-5)}`;
    await mockGeo(page);
    await enableE2eCameraMock(page);
    await openWizard(page);
    await completeWizardStepA(page, {
      ownerName: 'Multi Mode Owner',
      phone,
      base: 'shop',
    });
    await completeWizardStepB(page, {
      categoryLabel: PROD_CATEGORY,
      brandName: `Multi ${phone.slice(-4)}`,
      reach: 'vendor',
      modes: ['help', 'appointment'],
    });
    const { data: v } = await supabaseAdmin.from('vendors').select('id').eq('phone', phone).single();
    const { data: modes } = await supabaseAdmin
      .from('vendor_availability_modes')
      .select('mode')
      .eq('vendor_id', v!.id);
    const sorted = (modes ?? []).map((m) => m.mode).sort();
    expect(sorted).toEqual(['appointment']);
    await deleteVendor(phone);
  });
});
