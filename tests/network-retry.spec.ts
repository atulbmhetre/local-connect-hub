import { test, expect, Page } from '@playwright/test';
import dotenv from 'dotenv';
import { loginAsVendor, loginAsCustomer, openVendorMyBusinessTab, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  ensureVendorGoLivePhotos,
  seedVendorCategory,
} from './helpers/setup';
import {
  installAbortRoute,
  isGetMyOrdersRpc,
  isGetVendorOwnRpc,
  isVendorUpdateOwnRpc,
} from './helpers/network-retry-routes';

dotenv.config({ path: '.env.test' });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;

const T = Date.now();
const VENDOR_DEVICE_ID = `device_nretry_${T}`;
const CUSTOMER_DEVICE_ID = `device_nretry_cust_${T}`;
const CUSTOMER_PHONE = `88009${String(T).slice(-5)}`;

const L = {
  retrying: 'Connection is slow — still trying...',
  failed: "Couldn't connect. Check your internet and try again.",
  tryAgain: 'Try again',
  shopInfo: 'Shop Info',
  serviceAreaUpdated: 'Business details saved.',
  offline: 'Offline',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99009${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createVendor(tag: string): Promise<{ id: string; phone: string; shop_name: string }> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `NR Vendor ${tag}`,
      shop_name: `!NR-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: 'complete',
      service_radius_km: 15,
      vendor_type: 'shop',
      base_type: 'shop',
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  await ensureVendorGoLivePhotos(vendor.id);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function seedCustomer() {
  const { error } = await supabaseAdmin.from('users').upsert(
    {
      phone: CUSTOMER_PHONE,
      trust_score: 75,
      warn_count: 0,
      is_banned: false,
    },
    { onConflict: 'phone' },
  );
  if (error) throw error;
}

async function seedRequest(vendorId: string, message: string) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: CUSTOMER_DEVICE_ID,
      message,
      status: 'sent',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function disableBrowserCache(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
}

/** Force a fresh document load (avoids bfcache restoring React state without refetching). */
async function hardNavigate(page: Page, path: string) {
  await page.goto('about:blank');
  await page.goto(`${APP_URL}${path}`, { waitUntil: 'domcontentloaded' });
}

/** Probe whether raw fetch rejects or resolves when Playwright aborts a Supabase RPC POST. */
async function probeSupabaseRpcOnAbort(page: Page): Promise<'throws' | 'resolves'> {
  const pattern = `${SUPABASE_URL}/rest/v1/rpc/get_vendor_own*`;
  await page.route(pattern, (route) => void route.abort('failed'));

  const outcome = await page.evaluate(
    async ({ baseUrl, apikey }) => {
      try {
        await fetch(`${baseUrl}/rest/v1/rpc/get_vendor_own`, {
          method: 'POST',
          headers: {
            apikey,
            Authorization: `Bearer ${apikey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            p_vendor_id: '00000000-0000-0000-0000-000000000000',
            p_vendor_phone: '0000000000',
          }),
        });
        return 'resolves' as const;
      } catch {
        return 'throws' as const;
      }
    },
    { baseUrl: SUPABASE_URL, apikey: SUPABASE_ANON_KEY },
  );

  await page.unroute(pattern);
  return outcome;
}

async function warmVendorMode(page: Page, vendor: { id: string; phone: string }) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 30000 });
}

async function warmMyOrders(page: Page, vendorId: string, orderMessage: string) {
  await seedCustomer();
  await seedRequest(vendorId, orderMessage);
  await loginAsCustomer(page, CUSTOMER_PHONE, CUSTOMER_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('order-card').filter({ hasText: orderMessage })).toBeVisible({
    timeout: 20000,
  });
}

async function openVendorMyBusinessRadius(page: Page) {
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 15000 });
  await openVendorMyBusinessTab(page);
  await expect(page.getByTestId('my-business-radius')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('15 km').first()).toBeVisible({ timeout: 15000 });
}

/** Document whether fetch rejects (throws) vs resolves when Playwright aborts a request. */
async function probeFetchAbortBehavior(page: Page): Promise<'throws' | 'resolves'> {
  return page.evaluate(async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await fetch('https://example.com', { signal: controller.signal });
      return 'resolves' as const;
    } catch {
      return 'throws' as const;
    }
  });
}

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await disableBrowserCache(page);
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test.describe('TEST 1 — VendorMode mount fetch retries', () => {
  test('retries and recovers after aborted get_vendor_own RPC', async ({ page }) => {
    const vendor = await createVendor('vm-recover');
    await warmVendorMode(page, vendor);

    const fetchAbortBehavior = await probeFetchAbortBehavior(page);
    expect(fetchAbortBehavior).toBe('throws');

    const supabaseAbortBehavior = await probeSupabaseRpcOnAbort(page);
    expect(supabaseAbortBehavior).toBe('throws');

    // Note: restoreVendorLocationTracking (main.tsx) also calls get_vendor_own
    // once on page load, so it may consume some of the aborts — VendorMode's
    // withNetworkRetry still has to retry and recover for the UI to render.
    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/get_vendor_own*`,
      isGetVendorOwnRpc,
      { mode: 'fail-then-succeed', failCount: 2 },
    );

    await hardNavigate(page, '/vendor');
    await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });

    await expect(page.getByRole('status').getByText(L.retrying)).toBeVisible({ timeout: 20000 });

    await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 25000 });
    await expect(page.getByTestId('vendor-status-badge')).toHaveText(L.offline);
    await expect(page.getByRole('status').getByText(L.retrying)).not.toBeVisible({ timeout: 10000 });

    expect(route.abortedCount()).toBeGreaterThanOrEqual(2);
    expect(route.continuedCount()).toBeGreaterThanOrEqual(1);

    await route.unroute();
  });

  test('shows exhausted state when get_vendor_own RPC never succeeds', async ({ page }) => {
    const vendor = await createVendor('vm-exhaust');
    await warmVendorMode(page, vendor);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/get_vendor_own*`,
      isGetVendorOwnRpc,
      { mode: 'always-fail' },
    );

    await hardNavigate(page, '/vendor');
    await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });

    await expect(page.getByRole('alert').getByText(L.failed)).toBeVisible({ timeout: 35000 });
    await expect(page.getByRole('button', { name: L.tryAgain })).toBeVisible();

    expect(route.abortedCount()).toBeGreaterThanOrEqual(4);

    await route.unroute();
  });
});

test.describe('TEST 2 — MyOrders load retries', () => {
  test('retries and recovers after aborted get_my_orders RPC', async ({ page }) => {
    const orderMessage = `NR order recover ${T}`;
    const vendor = await createVendor('mo-recover');
    await warmMyOrders(page, vendor.id, orderMessage);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/get_my_orders*`,
      isGetMyOrdersRpc,
      { mode: 'fail-then-succeed', failCount: 2 },
    );

    await hardNavigate(page, '/my-orders');
    await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

    await expect(page.getByRole('status').getByText(L.retrying)).toBeVisible({ timeout: 20000 });

    await expect(page.getByTestId('order-card').filter({ hasText: orderMessage })).toBeVisible({
      timeout: 25000,
    });
    await expect(page.getByRole('status').getByText(L.retrying)).not.toBeVisible({ timeout: 10000 });

    expect(route.abortedCount()).toBeGreaterThanOrEqual(2);
    expect(route.continuedCount()).toBeGreaterThanOrEqual(1);

    await route.unroute();
  });

  test('shows exhausted state when get_my_orders RPC never succeeds', async ({ page }) => {
    const orderMessage = `NR order exhaust ${T}`;
    const vendor = await createVendor('mo-exhaust');
    await warmMyOrders(page, vendor.id, orderMessage);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/get_my_orders*`,
      isGetMyOrdersRpc,
      { mode: 'always-fail' },
    );

    await hardNavigate(page, '/my-orders');
    await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

    await expect(page.getByRole('alert').getByText(L.failed)).toBeVisible({ timeout: 35000 });
    await expect(page.getByRole('button', { name: L.tryAgain })).toBeVisible();

    expect(route.abortedCount()).toBeGreaterThanOrEqual(4);

    await route.unroute();
  });
});

test.describe('TEST 3 — My Business service radius retries', () => {
  test('retries and recovers after aborted vendor_update_own RPC', async ({ page }) => {
    const vendor = await createVendor('rad-recover');
    await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
    await page.goto(`${APP_URL}/vendor`);
    await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 20000 });
    await openVendorMyBusinessRadius(page);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/vendor_update_own`,
      isVendorUpdateOwnRpc,
      { mode: 'fail-then-succeed', failCount: 2 },
    );

    await page.getByText('5 km').first().click();
    await page.getByTestId('my-business-save').click();

    await expect(page.locator('[data-sonner-toast]').getByText(L.retrying)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-sonner-toast]').getByText(L.serviceAreaUpdated)).toBeVisible({
      timeout: 25000,
    });

    expect(route.abortedCount()).toBeGreaterThanOrEqual(2);
    expect(route.continuedCount()).toBeGreaterThanOrEqual(1);

    const { data } = await supabaseAdmin
      .from('vendors')
      .select('service_radius_km')
      .eq('id', vendor.id)
      .single();
    expect(data?.service_radius_km).toBe(5);

    await route.unroute();
  });

  test('shows exhausted toast when vendor_update_own RPC never succeeds', async ({ page }) => {
    const vendor = await createVendor('rad-exhaust');
    await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
    await page.goto(`${APP_URL}/vendor`);
    await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 20000 });
    await openVendorMyBusinessRadius(page);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/vendor_update_own`,
      isVendorUpdateOwnRpc,
      { mode: 'always-fail' },
    );

    await page.getByText('5 km').first().click();
    await page.getByTestId('my-business-save').click();

    await expect(page.locator('[data-sonner-toast]').getByText(L.failed)).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page.locator('[data-sonner-toast]').getByRole('button', { name: L.tryAgain }),
    ).toBeVisible();

    expect(route.abortedCount()).toBeGreaterThanOrEqual(4);

    await route.unroute();
  });
});
