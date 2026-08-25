import { test, expect, type Page } from '@playwright/test';
import { APP_URL } from './helpers/browser-setup';
import { ensureRegAvailabilityReady, setRegAvailabilityModes } from './helpers/regAvailability';
import {
  supabaseAdmin,
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
} from './helpers/setup';

async function mockGeo(page: Page, lat: number, lng: number) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: lat, longitude: lng });
  await page.evaluate(
    ({ lat: la, lng: ln }) => {
      (
        window as unknown as {
          __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
        }
      ).__E2E_MOCK_GEO__ = { lat: la, lng: ln, accuracy: 10 };
    },
    { lat, lng },
  );
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

async function completeWizardStepA(page: Page, opts: { ownerName: string; phone: string; upi: string }) {
  await page.getByPlaceholder('Ramesh Kumar').fill(opts.ownerName);
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(opts.phone);
  await page.getByTestId('reg-selfie-capture').click();
  await expect(page.getByTestId('reg-selfie-capture')).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Next' }).click();
}

async function completeWizardStepB(
  page: Page,
  opts: { categoryLabel: string; brandName: string; upi?: string },
) {
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = page.getByRole('button').filter({ hasText: opts.categoryLabel });
  await expect(chip.first()).toBeVisible({ timeout: 15000 });
  await chip.first().click();
  await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
  await page.getByPlaceholder(/Ramesh Tyre Works|e\.g\. Ramesh Home Kitchen/i).fill(opts.brandName);
  await page
    .getByRole('button', {
      name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन|📍 Capture|Location set/,
    })
    .click();
  await page.getByPlaceholder('name@okbank').fill(opts.upi ?? 'p2colocate@upi');
  await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  await ensureRegAvailabilityReady(page);
  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i }).click();
}

test.describe('Phase 2 colocation write path', () => {
  test('P2-A: same location shows reuse and inherits photo without admin green', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const electrician = await getActiveCategoryByLabel('Electrician');
    const plumber = await getActiveCategoryByLabel('Plumber');
    const phone = `99017${Date.now().toString().slice(-5)}`;
    const shopName = `P2 Same ${phone.slice(-4)}`;

    await mockGeo(page, 18.5204, 73.8567);
    await enableE2eCameraMock(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);

    await completeWizardStepA(page, {
      ownerName: 'P2 Same Owner',
      phone,
      upi: 'p2same@upi',
    });
    await completeWizardStepB(page, {
      categoryLabel: electrician.label,
      brandName: shopName,
      upi: 'p2same@upi',
    });
    await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

    const { data: vendor } = await supabaseAdmin
      .from('vendors')
      .select('id, latitude, longitude')
      .eq('phone', phone)
      .single();
    expect(vendor?.id).toBeTruthy();

    // Mark first/primary business admin-green so inherit must NOT copy it.
    await supabaseAdmin
      .from('vendor_categories')
      .update({ is_manual_verified: true, verification_status: 'business_verified' })
      .eq('vendor_id', vendor!.id)
      .eq('is_primary', true);

    await page.getByRole('button', { name: /Complete verification in Settings/i }).click();
    await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('my-business-add-business').click();
    await expect(page.getByText(/Add another business/i).first()).toBeVisible({ timeout: 10000 });
    const plumberChip = page
      .getByRole('button')
      .filter({ hasText: plumber.label })
      .filter({ hasText: /Help|Delivery|Appointment|Booking/i });
    await plumberChip.first().click();
    await page.getByTestId('add-business-base-shop').click();
    await page.getByTestId('add-business-upi').fill('p2sameadd@upi');
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
    await setRegAvailabilityModes(page, ['help'], 'add-business-avail');

    await page.getByTestId('add-business-shop-photo').click();
    await expect(page.getByTestId('add-business-same-shop')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('add-business-reuse-photo').click();
    await page.getByTestId('add-business-submit').click();

    await expect(page.getByText('Business details saved.')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('my-business-add-business')).toBeVisible({ timeout: 20000 });

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from('vendor_categories')
            .select('id')
            .eq('vendor_id', vendor!.id);
          return data?.length ?? 0;
        },
        { timeout: 20000 },
      )
      .toBe(2);

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from('vendor_categories')
            .select('shop_photo_url, is_primary')
            .eq('vendor_id', vendor!.id);
          const dst = (data ?? []).find((r) => !r.is_primary);
          return dst?.shop_photo_url ?? null;
        },
        { timeout: 20000 },
      )
      .toBeTruthy();

    const { data: rows } = await supabaseAdmin
      .from('vendor_categories')
      .select(
        'category_id, shop_photo_url, latitude, longitude, gps_match_distance, is_manual_verified, verification_status, is_primary',
      )
      .eq('vendor_id', vendor!.id);
    expect(rows?.length).toBe(2);
    const src = rows!.find((r) => r.is_primary)!;
    const dst = rows!.find((r) => !r.is_primary)!;
    expect(src).toBeTruthy();
    expect(dst).toBeTruthy();
    expect(dst.shop_photo_url).toBeTruthy();
    expect(dst.shop_photo_url).toBe(src.shop_photo_url);
    expect(Number(dst.latitude)).toBeCloseTo(Number(src.latitude!), 5);
    expect(Number(dst.longitude)).toBeCloseTo(Number(src.longitude!), 5);
    expect(dst.is_manual_verified).toBe(false);
    expect(src.is_manual_verified).toBe(true);
    expect(dst.verification_status).toBe('business_verified');

    await deleteVendorRegistrationArtifacts(vendor!.id);
  });

  test('P2-B: far location has no reuse and writes a distinct business pin', async ({ page }) => {
    test.setTimeout(120000);
    const electrician = await getActiveCategoryByLabel('Electrician');
    const plumber = await getActiveCategoryByLabel('Plumber');
    const phone = `99018${Date.now().toString().slice(-5)}`;
    const shopName = `P2 Far ${phone.slice(-4)}`;

    await mockGeo(page, 18.5204, 73.8567);
    await enableE2eCameraMock(page);
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);

    await completeWizardStepA(page, {
      ownerName: 'P2 Far Owner',
      phone,
      upi: 'p2far@upi',
    });
    await completeWizardStepB(page, {
      categoryLabel: electrician.label,
      brandName: shopName,
      upi: 'p2far@upi',
    });
    await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

    const { data: vendor } = await supabaseAdmin
      .from('vendors')
      .select('id, latitude, longitude')
      .eq('phone', phone)
      .single();

    await page.getByRole('button', { name: /Complete verification in Settings/i }).click();
    await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 10000 });

    // Move device GPS far away before add-business.
    await mockGeo(page, 19.076, 72.8777);

    await page.getByTestId('my-business-add-business').click();
    const plumberChip = page
      .getByRole('button')
      .filter({ hasText: plumber.label })
      .filter({ hasText: /Help|Delivery|Appointment|Booking/i });
    await plumberChip.first().click();
    await page.getByTestId('add-business-base-shop').click();
    await page.getByTestId('add-business-upi').fill('p2faradd@upi');
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
    await setRegAvailabilityModes(page, ['help'], 'add-business-avail');

    await page.getByTestId('add-business-shop-photo').click();
    await expect(page.getByTestId('add-business-same-shop')).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByTestId('add-business-shop-photo')).toContainText(
      /Re-shoot|Reshoot|Retake|फिर|पुन्हा/i,
      { timeout: 15000 },
    );
    await page.getByTestId('add-business-submit').click();
    await expect(page.getByTestId('my-business-add-business')).toBeVisible({ timeout: 20000 });

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from('vendor_categories')
            .select('latitude, longitude, shop_photo_url, is_primary')
            .eq('vendor_id', vendor!.id);
          const far = (data ?? []).find(
            (r) =>
              r.shop_photo_url &&
              r.latitude != null &&
              Math.abs(Number(r.latitude) - 19.076) < 0.05,
          );
          const near = (data ?? []).find(
            (r) =>
              r.latitude != null && Math.abs(Number(r.latitude) - 18.5204) < 0.05,
          );
          return far && near ? 'ok' : JSON.stringify(data);
        },
        { timeout: 20000 },
      )
      .toBe('ok');

    const { data: account } = await supabaseAdmin
      .from('vendors')
      .select('latitude, longitude')
      .eq('id', vendor!.id)
      .single();
    // Account pin remains first business (not overwritten by far second).
    expect(Number(account!.latitude)).toBeCloseTo(18.5204, 3);

    await deleteVendorRegistrationArtifacts(vendor!.id);
  });
});
