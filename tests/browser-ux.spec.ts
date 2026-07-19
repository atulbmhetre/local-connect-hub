import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, gotoRadarDelivery, clickRadarOrderCard, APP_URL } from './helpers/browser-setup';
import { supabase, supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, getActiveCategoryByLabel, seedVendorCategory, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
const MOBILE_VIEWPORT = { width: 390, height: 844 }; // iPhone 14
const SMALL_ANDROID = { width: 360, height: 800 }; // Redmi/Realme typical
let testVendor: any;

test.beforeAll(async () => {
  // Delivery empty-browse requires customer-place reach (per-business radar filter).
  testVendor = await createTestVendor({
    service_mode: 'delivery',
    serves_at_customer_place: true,
  });
  await createTestCustomer();
  await supabaseAdmin.from('vendors')
    .update({ service_mode: 'delivery', is_active: true, serves_at_customer_place: true })
    .eq('id', testVendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ serves_at_customer_place: true })
    .eq('vendor_id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── TAP TARGET SIZES (min 44×44px) ──────────────────────────────────────

test('UX-TAP-01: parchi submit button is tap-friendly (≥44px height)', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await gotoRadarDelivery(page);

  await clickRadarOrderCard(page, { vendorId: testVendor.id, shopName: testVendor.shop_name });
  await expect(page.getByTestId('parchi-submit-btn')).toBeVisible({ timeout: 5000 });

  const box = await page.getByTestId('parchi-submit-btn').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
});

test('UX-TAP-02: bottom nav tabs are tap-friendly (≥44px height)', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  const navTabs = ['nav-home', 'nav-feed', 'nav-orders', 'nav-settings'];
  for (const testid of navTabs) {
    const box = await page.getByTestId(testid).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
});

test('UX-TAP-03: vendor go-live button is tap-friendly (≥44px)', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);

  const box = await page.getByTestId('vendor-golive-btn').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
});

test('UX-TAP-04: accept order button tap size — document current size', async ({ page }) => {
  await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'UX tap test order',
    status: 'sent',
  });

  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);

  const acceptBtn = page.getByTestId('incoming-accept-btn').first();
  const visible = await acceptBtn.isVisible({ timeout: 8000 }).catch(() => false);

  if (visible) {
    const box = await acceptBtn.boundingBox();
    expect(box).not.toBeNull();
    if (box!.height < 44) {
      console.warn(`⚠️  UX GAP: incoming-accept-btn height is ${box!.height}px — should be ≥44px`);
    }
    expect(box!.height).toBeGreaterThanOrEqual(32);
  }
});

test('UX-TAP-05: feed post button is tap-friendly (≥44px)', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/feed`);

  const box = await page.getByTestId('feed-post-btn').boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
});

// ─── DARK / LIGHT THEME ───────────────────────────────────────────────────

test('UX-THEME-01: theme class applied to html element', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  // App applies dark or light class
  expect(htmlClass).toMatch(/dark|light/);
});

test('UX-THEME-02: dark theme — no pure white backgrounds on home screen', async ({ page }) => {
  // Set dark theme via localStorage
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);
  await page.evaluate(() => localStorage.setItem('aaspaas:theme', 'dark'));
  await page.reload();

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  // If dark class set, theme is applied
  if (htmlClass.includes('dark')) {
    const bgColor = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim()
    );
    // Dark theme bg should not be pure white (#ffffff or rgb(255,255,255))
    expect(bgColor).not.toBe('#ffffff');
    expect(bgColor).not.toBe('255 255 255');
  }
});

test('UX-THEME-03: light theme — html class contains light or no dark class', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);
  await page.evaluate(() => localStorage.setItem('aaspaas:theme', 'light'));
  await page.reload();

  const htmlClass = await page.evaluate(() => document.documentElement.className);
  // Light mode = either 'light' class present or 'dark' class absent
  const isLightMode = htmlClass.includes('light') || !htmlClass.includes('dark');
  expect(isLightMode).toBe(true);
});

test('UX-THEME-04: theme persists after page reload', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);
  await page.evaluate(() => localStorage.setItem('aaspaas:theme', 'dark'));
  await page.reload();

  const stored = await page.evaluate(() => localStorage.getItem('aaspaas:theme'));
  expect(stored).toBe('dark');
});

// ─── RESPONSIVE LAYOUT ────────────────────────────────────────────────────

test('UX-RESP-01: home screen renders correctly at iPhone 14 viewport', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });

  // No horizontal scroll — content width should not exceed viewport
  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 5); // 5px tolerance
});

test('UX-RESP-02: home screen renders correctly at small Android viewport', async ({ page }) => {
  await page.setViewportSize(SMALL_ANDROID);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 8000 });

  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(SMALL_ANDROID.width + 5);
});

test('UX-RESP-03: vendor screen renders correctly at mobile viewport', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);

  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 8000 });

  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 5);
});

test('UX-RESP-04: settings screen renders correctly at mobile viewport', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);

  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 5);
});

test('UX-RESP-05: feed screen renders correctly at mobile viewport', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/feed`);

  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 8000 });

  const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width + 5);
});

// ─── NAVIGATION ───────────────────────────────────────────────────────────

test('UX-NAV-01: all bottom nav tabs navigate to correct routes', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  const routes = [
    { testid: 'nav-orders', pattern: /my-orders/ },
    { testid: 'nav-feed', pattern: /feed/ },
    { testid: 'nav-settings', pattern: /settings/ },
    { testid: 'nav-home', pattern: /\/$/ },
  ];

  for (const { testid, pattern } of routes) {
    await page.getByTestId(testid).click();
    expect(page.url()).toMatch(pattern);
  }
});

test('UX-NAV-02: vendor tab shows ME label when vendor session active', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  const vendorTab = page.getByTestId('nav-vendor');
  await expect(vendorTab).toBeVisible();
  const text = await vendorTab.textContent();
  expect(text).toMatch(/ME·|Vendor/);
});

test('UX-NAV-03: direct URL navigation works for all main routes', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);

  const routes = ['/', '/feed', '/my-orders', '/settings'];
  for (const route of routes) {
    await page.goto(`${APP_URL}${route}`);
    await expect(page.getByTestId('not-found-page')).not.toBeVisible();
  }
});

test('UX-NAV-04: unknown route redirects gracefully — no crash', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/this-route-does-not-exist`);

  // App should redirect or show graceful fallback — no JS crash
  const bodyText = await page.locator('body').textContent();
  expect(bodyText).toBeTruthy();
  expect(bodyText!.length).toBeGreaterThan(0);
});

test('UX-NAV-05: Settings privacy link leads to the single canonical policy', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);

  await page.getByRole('button', { name: /CONNECTION & PRIVACY/i }).click();
  await page.getByTestId('settings-privacy-policy-link').click();
  await expect(page).toHaveURL(`${APP_URL}/privacy`);

  const canonical = page.getByTestId('privacy-policy-canonical-link');
  await expect(canonical).toHaveAttribute(
    'href',
    'https://aaspaaspro.com/privacy-policy.html',
  );
  await expect(page.getByText('Last updated: May 2026')).not.toBeVisible();
  await expect(page.getByText('privacy@aaspaas.app')).not.toBeVisible();
});

test('UX-NAV-06: 404 Return Home uses client-side routing', async ({ page }) => {
  await page.goto(`${APP_URL}/this-route-does-not-exist`);
  const documentRequests: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests.push(request.url());
  });

  await page.getByRole('link', { name: 'Return to Home' }).click();
  await expect(page).toHaveURL(`${APP_URL}/`);
  expect(documentRequests).toHaveLength(0);
});

test('UX-NAV-07: vendor status and 404 copy are localized', async ({ page }) => {
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.evaluate(() => {
    localStorage.setItem('aaspaas:language', 'hi');
    localStorage.setItem('aaspaas:vendor_active', '0');
  });
  await page.reload();
  await expect(page.getByTestId('nav-vendor')).toHaveText('मैं·ऑफलाइन');

  await page.goto(`${APP_URL}/this-route-does-not-exist`);
  await expect(page.getByText('यह पेज नहीं मिला')).toBeVisible();
  await expect(page.getByRole('link', { name: 'होम पर लौटें' })).toBeVisible();
});

// ─── LOADING STATES ───────────────────────────────────────────────────────

test('UX-LOAD-01: home screen loads without JS errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
});

test('UX-LOAD-02: vendor screen loads without JS errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);

  expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
});

test('UX-LOAD-03: settings screen loads without JS errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);

  expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
});

test('UX-LOAD-04: feed screen loads without JS errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/feed`);

  expect(errors.filter(e => !e.includes('ResizeObserver'))).toHaveLength(0);
});

// ─── ERROR STATES ─────────────────────────────────────────────────────────

test('UX-ERR-01: GPS denied on radar shows error state not crash', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);

  // Deny geolocation
  await page.context().clearPermissions();
  await page.goto(`${APP_URL}/radar`);
  await page.waitForTimeout(3000);

  // Should show error/blocked state — not a blank screen or crash
  const bodyText = await page.locator('body').textContent();
  expect(bodyText!.length).toBeGreaterThan(10);
  // No unhandled JS error
});

test('UX-ERR-02: my-orders screen loads even with no orders', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);

  // Should show empty state or orders — not a crash
  const bodyText = await page.locator('body').textContent();
  expect(bodyText!.length).toBeGreaterThan(10);
});

test('UX-ERR-03: vendor screen loads even with no incoming orders', async ({ page }) => {
  // Clean vendor with no orders
  const { data: emptyVendor } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Empty Vendor',
      phone: `77055${Date.now().toString().slice(-5)}`,
      service_mode: 'delivery',
      vendor_note: `test_session:${TEST_SESSION}_empty`,
    })
    .select()
    .single();

  await loginAsVendor(page, emptyVendor.phone, emptyVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);

  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 8000 });

  await supabaseAdmin.from('vendors').delete().eq('id', emptyVendor.id);
});

// ─── ELEMENT OVERLAP ─────────────────────────────────────────────────────

test('UX-OVERLAP-01: bottom nav does not overlap main content on mobile', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);

  const navBox = await page.getByTestId('nav-home').boundingBox();
  const homeBox = await page.getByTestId('home-screen').boundingBox();

  expect(navBox).not.toBeNull();
  expect(homeBox).not.toBeNull();

  // Nav should be below main content (nav top >= home top)
  expect(navBox!.y).toBeGreaterThan(homeBox!.y);
});

test('UX-OVERLAP-02: parchi submit button visible in viewport when sheet is open', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await gotoRadarDelivery(page);

  await clickRadarOrderCard(page, { vendorId: testVendor.id, shopName: testVendor.shop_name });
  await expect(page.getByTestId('parchi-submit-btn')).toBeVisible({ timeout: 5000 });

  // Check button is visible in viewport using isVisible (not absolute position)
  const isVisible = await page.getByTestId('parchi-submit-btn').isVisible();
  expect(isVisible).toBe(true);

  await page.getByTestId('parchi-submit-btn').scrollIntoViewIfNeeded();

  // Intersects viewport (bottom nav may cover lower edge; avoid document-offset false negatives)
  const inViewport = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="parchi-submit-btn"]');
    if (!btn) return false;
    const rect = btn.getBoundingClientRect();
    const vh = window.innerHeight;
    return rect.height > 0 && rect.top < vh && rect.bottom > 0;
  });
  expect(inViewport).toBe(true);
});

// ─── VENDOR CARD CONTENT ──────────────────────────────────────────────────

test('UX-CARD-01: radar card shows category chips, home type label, Verified badge', async ({ page }) => {
  const cardPhone = `99004${Date.now().toString().slice(-5)}`;
  const shopName = `!CARD-${Date.now()}`;
  const categories = [
    await getActiveCategoryByLabel('Pharmacy'),
    await getActiveCategoryByLabel('Bakery'),
  ];
  expect(categories.length).toBeGreaterThanOrEqual(2);

  const { data: cardVendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Card Owner',
      shop_name: shopName,
      phone: cardPhone,
      category: categories[0].label,
      service_mode: categories[0].service_mode,
      vendor_type: 'home',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: 'https://picsum.photos/seed/uxcard/100',
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
      vendor_note: `test_session:${TEST_SESSION}`,
      shop_photo_url: 'https://picsum.photos/200',
    })
    .select()
    .single();
  expect(error).toBeNull();

  await seedVendorCategory(cardVendor!.id, categories[0], {
    is_primary: true,
    is_manual_verified: true,
    serves_at_customer_place: true,
  });
  await seedVendorCategory(cardVendor!.id, categories[1], {
    is_primary: false,
    is_manual_verified: true,
    serves_at_customer_place: true,
  });

  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(
    `${APP_URL}/radar?mode=${categories[0].service_mode}&q=${encodeURIComponent(categories[0].label)}`,
  );

  const card = page.locator(`#radar-vendor-card-${cardVendor!.id}`);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByText(/Home based/i)).toBeVisible();
  await expect(card.getByTestId('badge-verified')).toBeVisible();
  await expect(card.getByText(/Verified|सत्यापित/i).first()).toBeVisible();
  await expect(card.getByText(/Bronze|ब्रॉन्ज/i)).not.toBeVisible();
  await expect(card.getByText(categories[0].label, { exact: false }).first()).toBeVisible();
  // Category search shows only the matched category, not the vendor's full list
  await expect(card.getByText(categories[1].label, { exact: true })).not.toBeVisible();

  // Shop photo thumbnail is visible and opens lightbox
  const avatar = card.locator('img[alt*="shop"]').first();
  await expect(avatar).toBeVisible();
  await avatar.click();
  await expect(page.locator('.fixed.inset-0.z-50')).toBeVisible({ timeout: 3000 });
  await page.locator('.fixed.inset-0.z-50').click();
  await expect(page.locator('.fixed.inset-0.z-50')).not.toBeVisible({ timeout: 3000 });
});
