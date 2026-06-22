import { test, expect, Page, Locator } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

/** Unique suffix for all test data in this file. */
const T = Date.now();
const CUSTOMER_PHONE = `88006${String(T).slice(-5)}`;
const DEVICE_ID = `device_fd_${T}`;

const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const DELHI = { latitude: 28.6139, longitude: 77.2090 };

const L = {
  notOnAaspaas: 'Not on Aaspaas yet',
  typeAnnouncement: 'Announcement',
  typeRecommendation: 'Recommendation',
  typeOffer: 'Offer',
  locationRequired: 'Enable location to share with your community',
  gpsRequired: 'Your location is needed to post',
  vendorWentOffline:
    'This vendor just went offline. Please try another or check back soon.',
  composeTitle: 'New post',
  minutesAgo: /minutes ago/i,
} as const;

const createdPostIds: string[] = [];
const createdVendorIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99006${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextFlagPhone(seq: number): string {
  return `88006${String(T + 100 + seq).slice(-5)}`;
}

async function seedCustomer() {
  const { error } = await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
  if (error) throw error;
}

type SeedPostFields = Record<string, unknown>;

async function seedPost(content: string, fields: SeedPostFields = {}) {
  const { data, error } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'announcement',
      user_phone: CUSTOMER_PHONE,
      vendor_id: null,
      content,
      lat: PUNE.latitude,
      lng: PUNE.longitude,
      locality: 'Pune',
      is_hidden: false,
      flagged_count: 0,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      starts_at: null,
      ...fields,
    })
    .select('id, content')
    .single();
  if (error) throw error;
  createdPostIds.push(data.id);
  return data;
}

async function createVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  tag: string,
  overrides: Record<string, unknown> = {},
) {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `FD Vendor ${tag}`,
      shop_name: `!FD-${tag}-${T}`,
      phone,
      category: category.label,
      service_mode: serviceMode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      ...overrides,
    })
    .select('id, phone, shop_name, category, service_mode')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return vendor;
}

async function setupPuneGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation(PUNE);
}

async function clearFeedCache(page: Page) {
  await page.evaluate(() => localStorage.removeItem('aaspaas:feed_cache'));
}

async function gotoFeed(page: Page, withGps = true) {
  if (withGps) {
    await setupPuneGeolocation(page);
  }
  await clearFeedCache(page);
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
}

function postCard(page: Page, content: string): Locator {
  return page.getByTestId('feed-post-card').filter({ hasText: content });
}

async function waitForPostCard(page: Page, content: string) {
  await expect(postCard(page, content)).toBeVisible({ timeout: 25000 });
}

test.beforeAll(async () => {
  await supabaseAdmin.from('feed_flags').delete().eq('flagged_by_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await seedCustomer();
});

test.afterAll(async () => {
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_flags').delete().in('post_id', createdPostIds);
    await supabaseAdmin.from('feed_replies').delete().in('post_id', createdPostIds);
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test.beforeEach(async ({ page }) => {
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
});

// ─── POST TYPES — CARD DISPLAY ───────────────────────────────────────────────

test('FD-REQ-01 — Announcement post card shows correct elements', async ({ page }) => {
  const authorPhone = nextVendorPhone();
  const content = `FD-REQ-01-${T}`;
  await seedPost(content, { user_phone: authorPhone });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await expect(card.getByText(content)).toBeVisible();
  await expect(card.getByText(L.minutesAgo)).toBeVisible();
  await expect(card.locator('text=/••••\\d{4}/')).toBeVisible();
  await expect(card.getByText(L.typeAnnouncement)).toBeVisible();
  await expect(card.getByText(L.notOnAaspaas)).not.toBeVisible();
  await expect(card.getByRole('button', { name: /!FD-/ })).not.toBeVisible();
});

test('FD-REQ-02 — Recommendation post with linked vendor — shows tappable chip', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'REC-LINK');
  const content = `FD-REQ-02-${T}`;
  await seedPost(content, {
    type: 'recommendation',
    recommended_vendor_id: vendor.id,
    recommended_vendor_name: null,
  });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  const chip = card.getByRole('button', { name: vendor.shop_name });
  await expect(chip).toBeVisible();
  await expect(card.getByText(L.notOnAaspaas)).not.toBeVisible();
});

test('FD-REQ-03 — Recommendation post with unlinked vendor — shows "Not on Aaspaas yet" badge', async ({
  page,
}) => {
  const shopName = `Test Shop ${T}`;
  const content = `FD-REQ-03-${T}`;
  await seedPost(content, {
    type: 'recommendation',
    recommended_vendor_id: null,
    recommended_vendor_name: shopName,
  });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await expect(card.getByText(L.notOnAaspaas)).toBeVisible();
  await expect(card.getByText(shopName)).toBeVisible();
  await expect(card.getByRole('button', { name: shopName })).not.toBeVisible();
});

test('FD-REQ-04 — Offer post shows vendor name and offer content', async ({ page }) => {
  const vendor = await createVendor('delivery', 'OFFER');
  const content = `FD-REQ-04-${T} — 10% off today`;
  await seedPost(content, {
    type: 'offer',
    vendor_id: vendor.id,
    user_phone: vendor.phone,
  });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await expect(card.getByText(content)).toBeVisible();
  await expect(card.getByText(L.typeOffer, { exact: true })).toBeVisible();
  await expect(card.getByText(vendor.shop_name)).toBeVisible();
});

// ─── LOCATION RULES ────────────────────────────────────────────────────────

test('FD-REQ-05 — Post outside radius not shown', async ({ page }) => {
  const content = `FD-REQ-05-DELHI-${T}`;
  await seedPost(content, { lat: DELHI.latitude, lng: DELHI.longitude, locality: 'Delhi' });
  await gotoFeed(page);
  await page.waitForLoadState('networkidle');
  await expect(postCard(page, content)).not.toBeVisible({ timeout: 10000 });
});

test('FD-REQ-06 — Post inside radius is shown', async ({ page }) => {
  const content = `FD-REQ-06-PUNE-${T}`;
  await seedPost(content);
  await gotoFeed(page);
  await waitForPostCard(page, content);
});

// ─── EXPIRY ────────────────────────────────────────────────────────────────

test('FD-REQ-07 — Expired post not shown in feed', async ({ page }) => {
  const content = `FD-REQ-07-EXPIRED-${T}`;
  await seedPost(content, {
    expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  await gotoFeed(page);
  await page.waitForLoadState('networkidle');
  await expect(postCard(page, content)).not.toBeVisible({ timeout: 10000 });
});

test('FD-REQ-08 — Future scheduled post not shown yet', async ({ page }) => {
  const content = `FD-REQ-08-FUTURE-${T}`;
  await seedPost(content, {
    starts_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  });
  await gotoFeed(page);
  await page.waitForLoadState('networkidle');
  await expect(postCard(page, content)).not.toBeVisible({ timeout: 10000 });
});

// ─── FLAGGING ──────────────────────────────────────────────────────────────

test('FD-REQ-09 — Flag button visible on post card', async ({ page }) => {
  const content = `FD-REQ-09-${T}`;
  await seedPost(content);
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('feed-flag-btn')).toBeVisible();
});

test('FD-REQ-10 — Flagging post increments flagged_count', async ({ page }) => {
  const content = `FD-REQ-10-${T}`;
  const post = await seedPost(content);
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await card.getByTestId('feed-flag-btn').click();
  await page.waitForTimeout(1500);

  await expect(card.getByTestId('feed-flag-btn')).toHaveAttribute('data-reported', 'true');
  await expect(card.getByTestId('feed-flag-btn')).toBeDisabled();

  const { data: afterFirst } = await supabaseAdmin
    .from('feed_posts')
    .select('flagged_count')
    .eq('id', post.id)
    .single();
  expect(afterFirst?.flagged_count).toBe(1);

  // Reported posts keep the flag button disabled — duplicate report blocked in UI.
  await expect(card.getByTestId('feed-flag-btn')).toBeDisabled();

  const { data: afterSecond } = await supabaseAdmin
    .from('feed_posts')
    .select('flagged_count')
    .eq('id', post.id)
    .single();
  expect(afterSecond?.flagged_count).toBe(1);
});

test('FD-REQ-11 — Post hidden after 5 flags', async ({ page }) => {
  const content = `FD-REQ-11-${T}`;
  const post = await seedPost(content);
  for (let i = 0; i < 5; i++) {
    const phone = nextFlagPhone(i);
    const { error } = await supabaseAdmin.rpc('increment_flag_count', {
      p_post_id: post.id,
      p_user_phone: phone,
    });
    if (error) throw error;
  }

  const { data: row } = await supabaseAdmin
    .from('feed_posts')
    .select('is_hidden, flagged_count')
    .eq('id', post.id)
    .single();
  expect(row?.is_hidden).toBe(true);
  expect(row?.flagged_count).toBeGreaterThanOrEqual(5);

  await gotoFeed(page);
  await page.waitForLoadState('networkidle');
  await expect(postCard(page, content)).not.toBeVisible({ timeout: 10000 });
});

// ─── PHONE NUMBER MASKING ──────────────────────────────────────────────────

test('FD-REQ-12 — Phone number not visible in post content', async ({ page }) => {
  const rawPhone = '9876543210';
  const tag = `FD-REQ-12-${T}`;
  const content = `${tag} Call me on ${rawPhone}`;
  await seedPost(content);
  await gotoFeed(page);
  const card = postCard(page, tag);
  await expect(card).toBeVisible();
  await expect(card.getByText(rawPhone)).not.toBeVisible();
});

// ─── VENDOR CHIP NAVIGATION ────────────────────────────────────────────────

test('FD-REQ-13 — Tapping vendor chip on recommendation navigates to Radar with vendor category', async ({
  page,
}) => {
  const vendor = await createVendor('delivery', 'CHIP-ONLINE', { is_active: true });
  const content = `FD-REQ-13-${T}`;
  await seedPost(content, {
    type: 'recommendation',
    recommended_vendor_id: vendor.id,
  });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: vendor.shop_name }).click();
  await expect(page).toHaveURL(new RegExp(`/radar\\?.*q=`), { timeout: 15000 });
  expect(page.url()).toContain(encodeURIComponent(vendor.category));
  // highlight wrapper + card both match — .first() targets card
  await expect(
    page
      .locator(`#radar-vendor-card-${vendor.id}`)
      .or(page.getByTestId('radar-vendor-card').filter({ hasText: vendor.shop_name }))
      .first(),
  ).toBeVisible({ timeout: 20000 });
});

test('FD-REQ-14 — Tapping vendor chip when vendor is offline shows toast, no navigation', async ({
  page,
}) => {
  const vendor = await createVendor('help', 'CHIP-OFFLINE', { is_active: false });
  const content = `FD-REQ-14-${T}`;
  await seedPost(content, {
    type: 'recommendation',
    recommended_vendor_id: vendor.id,
  });
  await gotoFeed(page);
  const card = postCard(page, content);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: vendor.shop_name }).click();
  await expect(
    page.locator('[data-sonner-toast]').getByText(L.vendorWentOffline, { exact: false }),
  ).toBeVisible({ timeout: 10000 });
  await expect(page).toHaveURL(/\/feed/);
});

// ─── CREATE POST ───────────────────────────────────────────────────────────

test('FD-REQ-15 — Create post button visible on feed', async ({ page }) => {
  await gotoFeed(page);
  await expect(page.getByTestId('feed-post-btn')).toBeVisible();
});

test('FD-REQ-16 — GPS required to create post — blocked without location', async ({
  page,
}) => {
  await page.context().clearPermissions();
  await clearFeedCache(page);
  await page.goto(`${APP_URL}/feed`);
  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('feed-post-btn')).toBeVisible();
  await page.getByTestId('feed-post-btn').click();
  await expect(page.getByRole('heading', { name: L.composeTitle })).not.toBeVisible({
    timeout: 5000,
  });
  await expect(page.locator('[data-sonner-toast]').getByText(L.gpsRequired)).toBeVisible({
    timeout: 5000,
  });
});
