import { test, expect, type Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

/**
 * Per-business operational stats on Radar (fulfilled from requests.category_id).
 * Cobbler with history must not leak onto Carpenter for the same account.
 */

const T = Date.now();
const CUSTOMER_PHONE = `88009${String(T).slice(-5)}`;
const DEVICE_ID = `device_p4stats_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

async function gotoRadar(page: Page, q: string, mode: string) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
  await page.goto(`${APP_URL}/radar?q=${encodeURIComponent(q)}&mode=${mode}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.getByTestId('radar-search-input').waitFor({ state: 'visible', timeout: 15000 });
}

test.beforeAll(async () => {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('STATS-01: Cobbler Radar shows fulfilled count; Carpenter shows none (same account)', async ({
  page,
}) => {
  test.setTimeout(90000);
  const cobbler = await getActiveCategoryByLabel('Cobbler');
  const carpenter = await getActiveCategoryByLabel('Carpenter');
  // Prefer help mode display path (helped line).
  await supabaseAdmin
    .from('categories')
    .update({ service_mode: 'help' })
    .in('id', [cobbler.id, carpenter.id]);

  const shopName = `!STATS-Split-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Stats Split Owner',
      shop_name: shopName,
      phone: `99020${String(T).slice(-5)}`,
      category: cobbler.label,
      service_mode: 'help',
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      discoverable: true,
      service_radius_km: 9999,
      is_manual_verified: true,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      // Account-wide pools deliberately inflated — must NOT appear on Carpenter.
      total_helped: 99,
      total_delivered: 99,
      on_time_rate: 99,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id, shop_name')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, { ...cobbler, service_mode: 'help' }, {
    is_primary: true,
    is_manual_verified: true,
    serves_at_customer_place: true,
    modes: ['help'],
  });
  await seedVendorCategory(vendor.id, { ...carpenter, service_mode: 'help' }, {
    is_primary: false,
    is_manual_verified: true,
    serves_at_customer_place: true,
    modes: ['help'],
  });

  // 5 fulfilled Cobbler requests; zero Carpenter.
  for (let i = 0; i < 5; i++) {
    const { data: req, error: reqErr } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: vendor.id,
        device_id: DEVICE_ID,
        user_phone: CUSTOMER_PHONE,
        message: `cobbler job ${i}`,
        status: 'fulfilled',
        service_mode: 'help',
        category_id: cobbler.id,
        fulfilled_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (reqErr) throw reqErr;
    createdRequestIds.push(req.id);
  }

  // RPC evidence before UI
  const { data: rpcRows, error: rpcErr } = await supabaseAdmin.rpc(
    'get_public_vendor_category_order_stats',
    {
      p_vendor_ids: [vendor.id],
      p_category_ids: [cobbler.id, carpenter.id],
    },
  );
  expect(rpcErr).toBeNull();
  const cobblerRow = (rpcRows ?? []).find(
    (r: { category_id: string }) => r.category_id === cobbler.id,
  );
  const carpenterRow = (rpcRows ?? []).find(
    (r: { category_id: string }) => r.category_id === carpenter.id,
  );
  expect(cobblerRow?.fulfilled).toBe(5);
  expect(carpenterRow).toBeFalsy(); // zero fulfilled → no row
  console.log('STATS-01 RPC:', { cobbler: cobblerRow, carpenter: carpenterRow });

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);

  await gotoRadar(page, cobbler.label, 'help');
  const cobblerCard = page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
  await expect(cobblerCard).toBeVisible({ timeout: 25000 });
  const helped = cobblerCard.getByTestId('radar-reputation-helped');
  await expect(helped).toBeVisible();
  await expect(helped).toHaveAttribute('data-count', '5');
  console.log('STATS-01 Cobbler aria:', await helped.ariaSnapshot());

  await gotoRadar(page, carpenter.label, 'help');
  const carpenterCard = page.getByTestId('radar-vendor-card').filter({ hasText: shopName });
  await expect(carpenterCard).toBeVisible({ timeout: 25000 });
  const carpenterHelped = carpenterCard.getByTestId('radar-reputation-helped');
  await expect(carpenterHelped).toHaveCount(0);
  // Account pool total_helped=99 must not surface on the per-business reputation line.
  await expect(
    carpenterCard.locator('[data-testid="radar-reputation-helped"][data-count="99"]'),
  ).toHaveCount(0);
  console.log('STATS-01 Carpenter card has no helped line (account total_helped=99 ignored)');
});
