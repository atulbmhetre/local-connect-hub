/**
 * STEP 1 evidence: real VendorRegistrationWizard on TEST must write
 * vendor_category_modes and appear in get_radar_category_mode_matches.
 * Keep vendor for review (shop_name prefix STEP1_MODES_).
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { APP_URL } from './helpers/browser-setup';
import { supabaseAdmin, getActiveCategoryByLabel } from './helpers/setup';

const LAT = 18.5204;
const LNG = 73.8567;
const EVIDENCE = path.join(process.cwd(), 'tmp', 'step1-modes-verify.json');

async function mockVendorGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: LAT, longitude: LNG });
}

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

test('STEP1: UI register writes vendor_category_modes + radar match', async ({ page }) => {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  expect(url).toContain('hhdylnhqdzfabsolwxdz');

  const category = await getActiveCategoryByLabel('Electrician');
  expect(category?.id).toBeTruthy();
  const phone = `9911${String(Date.now()).slice(-6)}`;
  const shopName = `STEP1_MODES_Electrician_${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await page.getByPlaceholder('Ramesh Kumar').fill('Step1 Modes Owner');
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
  await page.getByPlaceholder('name@okbank').fill('step1modes@upi');
  await page.locator('button').filter({ hasText: /Shop|दुकान/ }).first().click();
  await page
    .getByRole('button', {
      name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन|📍 Capture|Location set/,
    })
    .click();
  await page.getByTestId('reg-selfie-capture').click();
  await expect(page.getByTestId('reg-selfie-capture')).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Next' }).click();

  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = page
    .getByRole('button')
    .filter({ hasText: 'Electrician' })
    .filter({ hasText: /Help|Delivery|Appointment|Booking/i });
  await expect(chip.first()).toBeVisible({ timeout: 15000 });
  await chip.first().click();
  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  // Match VR-E2E-01: at-my-place reach + help availability (customer-place not required for STEP1).
  await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  await page.getByTestId('reg-avail-help').click();
  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 30000 });

  const { data: vendor, error: vErr } = await supabaseAdmin
    .from('vendors')
    .select('id, shop_name, phone, latitude, longitude, service_mode, service_radius_km')
    .eq('phone', phone)
    .maybeSingle();
  expect(vErr).toBeNull();
  expect(vendor?.id).toBeTruthy();

  const { data: vcRows, error: vcErr } = await supabaseAdmin
    .from('vendor_categories')
    .select('id, vendor_id, category_id, status, service_mode')
    .eq('vendor_id', vendor!.id);
  expect(vcErr).toBeNull();
  expect(vcRows?.length).toBeGreaterThan(0);
  const vc = vcRows![0];

  const { data: modes, error: mErr } = await supabaseAdmin
    .from('vendor_category_modes')
    .select('vendor_category_id, mode')
    .eq('vendor_category_id', vc.id);
  expect(mErr).toBeNull();
  expect(modes?.length).toBeGreaterThan(0);
  expect(modes!.some((m) => m.mode === 'help')).toBe(true);

  const { data: matches, error: rpcErr } = await supabaseAdmin.rpc(
    'get_radar_category_mode_matches',
    { p_mode: 'help', p_category_ids: [category!.id] },
  );
  expect(rpcErr).toBeNull();
  const hit = (matches ?? []).find(
    (r: { vendor_id: string; category_id: string }) =>
      r.vendor_id === vendor!.id && r.category_id === category!.id,
  );
  expect(hit).toBeTruthy();

  const evidence = {
    step: 1,
    env: url,
    phone,
    vendor,
    vendor_categories: vcRows,
    vendor_category_modes: modes,
    radar_match: hit,
    category_id: category!.id,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
  // eslint-disable-next-line no-console
  console.log('STEP1_EVIDENCE', JSON.stringify(evidence, null, 2));
});
