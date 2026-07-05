import { test, expect, Page } from '@playwright/test';
import dotenv from 'dotenv';
import { loginAsVendor, loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import {
  installAbortRoute,
  isMyOrdersListFetch,
  isVendorByIdFetch,
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
  serviceAreaUpdated: 'Service area updated',
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
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
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

function vendorFetchUrl(vendorId: string): string {
  return `${SUPABASE_URL}/rest/v1/vendors?select=*&id=eq.${vendorId}`;
}

/** Probe whether raw fetch rejects or resolves when Playwright aborts a Supabase REST call. */
async function probeSupabaseFetchOnAbort(
  page: Page,
  targetUrl: string,
): Promise<'throws' | 'resolves'> {
  const pattern = `${SUPABASE_URL}/rest/v1/vendors*`;
  await page.route(pattern, (route) => {
    if (route.request().url().includes(targetUrl.split('?')[1] ?? '')) {
      void route.abort('failed');
      return;
    }
    void route.continue();
  });

  const outcome = await page.evaluate(
    async ({ url, apikey }) => {
      try {
        await fetch(url, {
          headers: {
            apikey,
            Authorization: `Bearer ${apikey}`,
            Accept: 'application/vnd.pgrst.object+json',
          },
        });
        return 'resolves' as const;
      } catch {
        return 'throws' as const;
      }
    },
    { url: targetUrl, apikey: SUPABASE_ANON_KEY },
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

async function openVendorShopInfo(page: Page) {
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: L.shopInfo }).click();
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
  test('retries and recovers after aborted vendors fetch', async ({ page }) => {
    const vendor = await createVendor('vm-recover');
    await warmVendorMode(page, vendor);

    const fetchAbortBehavior = await probeFetchAbortBehavior(page);
    expect(fetchAbortBehavior).toBe('throws');

    const supabaseAbortBehavior = await probeSupabaseFetchOnAbort(page, vendorFetchUrl(vendor.id));
    expect(supabaseAbortBehavior).toBe('throws');

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/vendors*`,
      (url, method) => isVendorByIdFetch(url, method, vendor.id),
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

  test('shows exhausted state when vendors fetch never succeeds', async ({ page }) => {
    const vendor = await createVendor('vm-exhaust');
    await warmVendorMode(page, vendor);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/vendors*`,
      (url, method) => isVendorByIdFetch(url, method, vendor.id),
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
  test('retries and recovers after aborted requests fetch', async ({ page }) => {
    const orderMessage = `NR order recover ${T}`;
    const vendor = await createVendor('mo-recover');
    await warmMyOrders(page, vendor.id, orderMessage);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/requests*`,
      isMyOrdersListFetch,
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

  test('shows exhausted state when requests fetch never succeeds', async ({ page }) => {
    const orderMessage = `NR order exhaust ${T}`;
    const vendor = await createVendor('mo-exhaust');
    await warmMyOrders(page, vendor.id, orderMessage);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/requests*`,
      isMyOrdersListFetch,
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

test.describe('TEST 3 — VendorSettings service radius retries', () => {
  test('retries and recovers after aborted vendor_update_own RPC', async ({ page }) => {
    const vendor = await createVendor('rad-recover');
    await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
    await page.goto(`${APP_URL}/vendor`);
    await expect(page.getByTestId('vendor-golive-btn')).toBeVisible({ timeout: 20000 });
    await openVendorShopInfo(page);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/vendor_update_own`,
      isVendorUpdateOwnRpc,
      { mode: 'fail-then-succeed', failCount: 2 },
    );

    await page.getByText('5 km').first().click();

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
    await openVendorShopInfo(page);

    const route = await installAbortRoute(
      page,
      `${SUPABASE_URL}/rest/v1/rpc/vendor_update_own`,
      isVendorUpdateOwnRpc,
      { mode: 'always-fail' },
    );

    await page.getByText('5 km').first().click();

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
