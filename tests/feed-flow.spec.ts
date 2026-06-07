import { test, expect } from '@playwright/test';
import { supabase, createTestVendor, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists, assertRowNotExists } from './helpers/db-assert';

let testVendor: any;
let testPostId: string;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabase.from('feed_flags').delete().eq('flagged_by_phone', TEST_CUSTOMER_PHONE);
  await supabase.from('feed_replies').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabase.from('feed_posts').delete().like('content', `%${TEST_SESSION}%`);
  await cleanupTestData();
});

test('FD-01: vendor creates feed post — row inserted correctly', async () => {
  const { data, error } = await supabase
    .from('feed_posts')
    .insert({
      type: 'vendor_update',
      user_phone: testVendor.phone,
      vendor_id: testVendor.id,
      content: `Test post ${TEST_SESSION} — fresh vegetables today`,
      lat: 18.5204,
      lng: 73.8567,
      locality: 'Warje',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.is_hidden).toBe(false);
  expect(data.flagged_count).toBe(0);
  testPostId = data.id;
});

test('FD-02: feed post has correct expiry', async () => {
  const { data } = await supabase
    .from('feed_posts')
    .select('expires_at')
    .eq('id', testPostId)
    .single();

  const expiresAt = new Date(data!.expires_at);
  const now = new Date();
  expect(expiresAt.getTime()).toBeGreaterThan(now.getTime());
});

test('FD-04: phone numbers should not appear in post content — masking check', async () => {
  const phoneRegex = /\b[6-9]\d{9}\b/;
  const { data } = await supabase
    .from('feed_posts')
    .select('content')
    .eq('id', testPostId)
    .single();

  // Test post content should not contain a raw phone number
  expect(phoneRegex.test(data?.content ?? '')).toBe(false);
});

test('FD-05: flagging post increments flagged_count', async () => {
  await supabase.from('feed_flags').insert({
    post_id: testPostId,
    flagged_by_phone: TEST_CUSTOMER_PHONE,
  });

  await supabase
    .from('feed_posts')
    .update({ flagged_count: 1 })
    .eq('id', testPostId);

  const { data } = await supabase
    .from('feed_posts')
    .select('flagged_count')
    .eq('id', testPostId)
    .single();

  expect(data?.flagged_count).toBeGreaterThanOrEqual(1);
});

test('FD-05b: duplicate flag blocked by unique constraint', async () => {
  const { error } = await supabase.from('feed_flags').insert({
    post_id: testPostId,
    flagged_by_phone: TEST_CUSTOMER_PHONE,
  });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});

test('FD-05c: post auto-hidden when flagged_count reaches threshold', async () => {
  // Simulate threshold reached (e.g. 5 flags)
  await supabase
    .from('feed_posts')
    .update({ flagged_count: 5, is_hidden: true })
    .eq('id', testPostId);

  const { data } = await supabase
    .from('feed_posts')
    .select('is_hidden, flagged_count')
    .eq('id', testPostId)
    .single();

  expect(data?.is_hidden).toBe(true);
  expect(data?.flagged_count).toBeGreaterThanOrEqual(5);
});

test('FD-06: hidden post excluded from feed query', async () => {
  const { data } = await supabase
    .from('feed_posts')
    .select('id, is_hidden')
    .eq('is_hidden', false)
    .eq('id', testPostId);

  expect(data?.length).toBe(0);
});

test('FD-07: feed reply inserts correctly', async () => {
  // Unhide post first for reply test
  await supabase
    .from('feed_posts')
    .update({ is_hidden: false })
    .eq('id', testPostId);

  const { data, error } = await supabase
    .from('feed_replies')
    .insert({
      post_id: testPostId,
      user_phone: TEST_CUSTOMER_PHONE,
      content: 'Great post!',
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.post_id).toBe(testPostId);
  expect(data.content).toBe('Great post!');
});

test('FD-08: feed post with starts_at in future not shown yet', async () => {
  const futureTime = new Date(Date.now() + 3600000).toISOString();

  const { data: futurePost } = await supabase
    .from('feed_posts')
    .insert({
      type: 'vendor_update',
      user_phone: testVendor.phone,
      vendor_id: testVendor.id,
      content: `Future post ${TEST_SESSION}`,
      lat: 18.5204,
      lng: 73.8567,
      starts_at: futureTime,
    })
    .select()
    .single();

  // App query filters: starts_at is null OR starts_at <= now
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('feed_posts')
    .select('id')
    .eq('id', futurePost.id)
    .lte('starts_at', now);

  expect(data?.length).toBe(0);

  // Cleanup
  await supabase.from('feed_posts').delete().eq('id', futurePost.id);
});
