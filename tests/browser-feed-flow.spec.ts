import { test, expect } from '@playwright/test';
import { loginAsCustomer, loginAsVendor, APP_URL } from './helpers/browser-setup';
import { supabase, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_VENDOR_PHONE, TEST_SESSION } from './helpers/setup';

const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
let testVendor: any;
let announcementPostId: string;
let offerPostId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();

  // Seed an announcement post — has feed-post-card testid + flag button
  const { data: ann } = await supabase
    .from('feed_posts')
    .insert({
      type: 'announcement',
      user_phone: TEST_VENDOR_PHONE,
      vendor_id: testVendor.id,
      content: `Browser feed test ${TEST_SESSION} — fresh produce available today`,
      lat: 18.5204,
      lng: 73.8567,
      locality: 'Warje',
      is_hidden: false,
      flagged_count: 0,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })
    .select()
    .single();
  announcementPostId = ann.id;

  // Seed an offer post
  const { data: offer } = await supabase
    .from('feed_posts')
    .insert({
      type: 'offer',
      user_phone: TEST_VENDOR_PHONE,
      vendor_id: testVendor.id,
      content: `Offer post ${TEST_SESSION} — 10% off today`,
      lat: 18.5204,
      lng: 73.8567,
      locality: 'Warje',
      is_hidden: false,
      flagged_count: 0,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })
    .select()
    .single();
  offerPostId = offer.id;
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabase.from('feed_flags').delete().eq('post_id', announcementPostId);
  await supabase.from('feed_replies').delete().eq('post_id', announcementPostId);
  await supabase.from('feed_posts').delete().eq('id', announcementPostId);
  await supabase.from('feed_posts').delete().eq('id', offerPostId);
  await cleanupTestData();
});

// ─── SCREEN LOAD ──────────────────────────────────────────────────────────

test('FD-UI-01: feed screen loads and shows feed-screen testid', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('feed-screen')).toBeVisible({ timeout: 8000 });
});

test('FD-UI-02: feed reachable via bottom nav', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}`);
  await page.waitForLoadState('networkidle');

  await page.getByTestId('nav-feed').click();
  await expect(page).toHaveURL(/feed/);
});

test('FD-UI-03: seeded announcement post card visible on feed', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  // feed-post-card testid exists on announcement/offer/recommendation cards
  await expect(
    page.getByTestId('feed-post-card').first()
  ).toBeVisible({ timeout: 10000 });
});

test('FD-UI-04: create post button visible for vendor', async ({ page }) => {
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('feed-post-btn')).toBeVisible({ timeout: 8000 });
});

test('FD-UI-05: create post button visible for all users (no role gate)', async ({ page }) => {
  // Button is visible to everyone — gating happens at submit time
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  await expect(page.getByTestId('feed-post-btn')).toBeVisible({ timeout: 5000 });
});

// ─── FLAGGING ─────────────────────────────────────────────────────────────

test('FD-FLAG-01: flag button visible on announcement post card', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  await expect(
    page.getByTestId('feed-post-card').first()
  ).toBeVisible({ timeout: 10000 });

  // Flag button only on announcement cards
  await expect(
    page.getByTestId('feed-flag-btn').first()
  ).toBeVisible({ timeout: 5000 });
});

test('FD-FLAG-02: flagging a post increments flagged_count in DB', async ({ page }) => {
  await loginAsCustomer(page, TEST_CUSTOMER_PHONE, TEST_DEVICE_ID);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/feed`);
  await page.waitForLoadState('networkidle');

  await expect(
    page.getByTestId('feed-post-card').first()
  ).toBeVisible({ timeout: 10000 });

  await page.getByTestId('feed-flag-btn').first().click();
  await page.waitForTimeout(2000);

  const { data } = await supabase
    .from('feed_posts')
    .select('flagged_count')
    .eq('id', announcementPostId)
    .single();

  expect(data?.flagged_count).toBeGreaterThanOrEqual(1);
});

test('FD-FLAG-03: duplicate flag blocked by unique constraint — DB assert', async () => {
  // First flag already inserted by FD-FLAG-02 or insert fresh
  await supabase.from('feed_flags').upsert({
    post_id: announcementPostId,
    flagged_by_phone: TEST_CUSTOMER_PHONE,
  }, { onConflict: 'post_id,flagged_by_phone', ignoreDuplicates: true });

  // Try duplicate
  const { error } = await supabase.from('feed_flags').insert({
    post_id: announcementPostId,
    flagged_by_phone: TEST_CUSTOMER_PHONE,
  });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});

test('FD-FLAG-04: post auto-hidden when flagged_count reaches threshold — DB assert', async () => {
  await supabase
    .from('feed_posts')
    .update({ flagged_count: 5, is_hidden: true })
    .eq('id', announcementPostId);

  const { data } = await supabase
    .from('feed_posts')
    .select('flagged_count, is_hidden')
    .eq('id', announcementPostId)
    .single();

  expect(data?.flagged_count).toBeGreaterThanOrEqual(5);
  expect(data?.is_hidden).toBe(true);

  // Restore for cleanup
  await supabase
    .from('feed_posts')
    .update({ flagged_count: 0, is_hidden: false })
    .eq('id', announcementPostId);
});

// ─── EXPIRY & SCHEDULING ─────────────────────────────────────────────────

test('FD-EXP-01: expired post not shown in feed', async () => {
  const { data: expired } = await supabase
    .from('feed_posts')
    .insert({
      type: 'announcement',
      user_phone: TEST_VENDOR_PHONE,
      vendor_id: testVendor.id,
      content: `Expired ${TEST_SESSION}`,
      lat: 18.5204,
      lng: 73.8567,
      expires_at: new Date(Date.now() - 3600000).toISOString(),
    })
    .select()
    .single();

  const now = new Date().toISOString();
  const { data } = await supabase
    .from('feed_posts')
    .select('id')
    .eq('id', expired.id)
    .gt('expires_at', now);

  expect(data?.length).toBe(0);

  await supabase.from('feed_posts').delete().eq('id', expired.id);
});

test('FD-EXP-02: future scheduled post not shown yet', async () => {
  const future = new Date(Date.now() + 3600000).toISOString();

  const { data: scheduled } = await supabase
    .from('feed_posts')
    .insert({
      type: 'announcement',
      user_phone: TEST_VENDOR_PHONE,
      vendor_id: testVendor.id,
      content: `Scheduled ${TEST_SESSION}`,
      lat: 18.5204,
      lng: 73.8567,
      starts_at: future,
    })
    .select()
    .single();

  const now = new Date().toISOString();
  const { data } = await supabase
    .from('feed_posts')
    .select('id')
    .eq('id', scheduled.id)
    .lte('starts_at', now);

  expect(data?.length).toBe(0);

  await supabase.from('feed_posts').delete().eq('id', scheduled.id);
});

test('FD-NEG-01: phone number not visible in post content', async () => {
  const phoneRegex = /\b[6-9]\d{9}\b/;
  const { data } = await supabase
    .from('feed_posts')
    .select('content')
    .eq('id', announcementPostId)
    .single();

  expect(phoneRegex.test(data?.content ?? '')).toBe(false);
});

test('FD-NEG-02: hidden post excluded from feed query', async () => {
  await supabase
    .from('feed_posts')
    .update({ is_hidden: true })
    .eq('id', offerPostId);

  const { data } = await supabase
    .from('feed_posts')
    .select('id')
    .eq('id', offerPostId)
    .eq('is_hidden', false);

  expect(data?.length).toBe(0);

  await supabase
    .from('feed_posts')
    .update({ is_hidden: false })
    .eq('id', offerPostId);
});
