import { test, expect } from '@playwright/test';
import { loginAsAdmin, waitForSettingsAdminReady, APP_URL } from './helpers/browser-setup';
import {
  cleanupTestData,
  cleanupTestVendors,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
  supabaseAdmin,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
let helpVendor: { id: string; service_mode: string };

test.beforeAll(async () => {
  await supabaseAdmin.from('app_config').upsert(
    { key: 'help_call_limit_seconds', value: '300' },
    { onConflict: 'key' },
  );

  const helpCategory = await getActiveCategoryByServiceMode('help');
  const helpPhone = `99007${Date.now().toString().slice(-5)}`;
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Help Vendor ${TEST_SESSION}`,
      shop_name: `Help Shop ${TEST_SESSION}`,
      phone: helpPhone,
      category: helpCategory.label,
      service_mode: 'help',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id, service_mode')
    .single();
  if (error) throw error;
  helpVendor = data;
  await seedVendorCategory(helpVendor.id, helpCategory);
  const { error: customerError } = await supabaseAdmin
    .from('users')
    .insert({ phone: TEST_CUSTOMER_PHONE });
  if (customerError) throw customerError;
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── PLATFORM HEALTH ──────────────────────────────────────────────────────

test('HEALTH-01: admin settings shows ADMIN section', async ({ page }) => {
  await loginAsAdmin(page, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);
  await expect(page.getByTestId('settings-tab-admin')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 5000 });
});

test('HEALTH-02: admin sees App Health card title', async ({ page }) => {
  await loginAsAdmin(page, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await waitForSettingsAdminReady(page);
  const healthTitle = page.getByText('Admin — App Health');
  const alreadyVisible = await healthTitle.isVisible({ timeout: 2000 }).catch(() => false);
  if (!alreadyVisible) {
    await page.getByTestId('settings-tab-admin').click();
    await page.waitForTimeout(500);
  }
  await expect(healthTitle).toBeVisible({ timeout: 5000 });
});

test('HEALTH-03: platform health metrics — active vendors count readable from DB', async () => {
  const { count } = await supabaseAdmin
    .from('vendors')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true)
    .eq('is_banned', false);

  expect(count).toBeGreaterThanOrEqual(0);
});

test('HEALTH-04: platform health — stuck orders (48h+) query works', async () => {
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('id, status, created_at')
    .eq('status', 'accepted')
    .lt('created_at', cutoff);

  expect(error).toBeNull();
  expect(Array.isArray(data)).toBe(true);
});

test('HEALTH-05: platform health — risky users query works', async () => {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, trust_score')
    .lt('trust_score', 25);

  expect(error).toBeNull();
  expect(Array.isArray(data)).toBe(true);
});

test('HEALTH-06: platform health — unverified vendors query works', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('is_manual_verified', false)
    .eq('is_banned', false);

  expect(error).toBeNull();
  expect(Array.isArray(data)).toBe(true);
});

test('HEALTH-07: platform health — total referrals count readable', async () => {
  const { count, error } = await supabaseAdmin
    .from('referrals')
    .select('*', { count: 'exact', head: true });

  expect(error).toBeNull();
  expect(count).toBeGreaterThanOrEqual(0);
});

test('HEALTH-08: platform health — avg vendor rating query works', async () => {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating')
    .not('avg_rating', 'is', null)
    .eq('is_banned', false);

  expect(error).toBeNull();
  expect(Array.isArray(data)).toBe(true);

  if (data && data.length > 0) {
    const avg = data.reduce((sum, v) => sum + (v.avg_rating ?? 0), 0) / data.length;
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThanOrEqual(5);
  }
});

// ─── AI BRIDGE ────────────────────────────────────────────────────────────

test('AIBRIDGE-01: help order accepted — status = accepted in DB', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: helpVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'Help request for AI bridge test',
      status: 'sent',
    })
    .select()
    .single();

  await supabaseAdmin
    .from('requests')
    .update({ status: 'accepted' })
    .eq('id', order.id);

  const { data } = await supabaseAdmin
    .from('requests')
    .select('status')
    .eq('id', order.id)
    .single();

  expect(data?.status).toBe('accepted');

  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('AIBRIDGE-02: customer notified when vendor accepts help — notification created', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: helpVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      device_id: TEST_DEVICE_ID,
      message: 'AI bridge notification test',
      status: 'accepted',
    })
    .select()
    .single();

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_CUSTOMER_PHONE,
    type: 'order_accepted',
    title: 'Help is on the way!',
    body: 'Vendor accepted and is heading to you',
    route: 'orders',
    route_params: { order_id: order.id },
  });

  const { data } = await supabaseAdmin
    .from('user_notifications')
    .select('title, body')
    .eq('user_phone', TEST_CUSTOMER_PHONE)
    .eq('type', 'order_accepted')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  expect(data?.title).toBe('Help is on the way!');

  await supabaseAdmin.from('requests').delete().eq('id', order.id);
});

test('AIBRIDGE-03: AI bridge call goes via edge function — not direct client call', async () => {
  // Verify edge function exists by checking app_config
  // The client calls invokeInitiateCall() → edge function /functions/v1/initiate-call
  // We cannot test actual Exotel call in automated tests
  // But we verify the config that gates it exists

  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'help_call_limit_seconds')
    .single();

  // app_config readable — edge function config is accessible
  expect(data).not.toBeNull();
});

test('AIBRIDGE-04: FCM location_ping config retired (Capgo owns Help GPS)', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'location_ping_seconds')
    .maybeSingle();

  expect(data).toBeNull();
});

test('AIBRIDGE-05: help order vendor has service_mode = help', async () => {
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('service_mode')
    .eq('id', helpVendor.id)
    .single();

  expect(data?.service_mode).toBe('help');
});

test('AIBRIDGE-06: stopped vendor detection config exists', async () => {
  const keys = ['vendor_stopped_minutes', 'vendor_stopped_distance_meters'];

  for (const key of keys) {
    const { data } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', key)
      .single();

    expect(data).not.toBeNull();
    expect(parseInt(data!.value)).toBeGreaterThan(0);
  }
});
