/**
 * Clear My Data RPC — retained vs cleared categories per approved classification.
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  cleanupTestData,
  createTestVendor,
  ensureVendorGoLivePhotos,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const DEVICE_ID = `device_cmd_${T}`;

function nextPhone(): string {
  return `88007${String(T + Math.floor(Math.random() * 10000)).slice(-5)}`;
}

const createdPhones: string[] = [];
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPostIds: string[] = [];

test.afterEach(async () => {
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_replies').delete().in('post_id', createdPostIds);
    await supabaseAdmin.from('feed_flags').delete().in('post_id', createdPostIds);
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
    createdPostIds.length = 0;
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('vendor_reviews').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
    createdRequestIds.length = 0;
  }
  for (const vendorId of createdVendorIds) {
    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', vendorId);
    await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
  }
  createdVendorIds.length = 0;
  for (const phone of createdPhones) {
    await cleanupTestData(phone);
  }
  createdPhones.length = 0;
});

async function invokeClearMyData(phone: string) {
  const { error } = await supabase.rpc('clear_my_data', {
    p_user_phone: phone,
    p_device_id: DEVICE_ID,
  });
  expect(error, error?.message).toBeNull();
}

test('CMD-01 — orders and bills survive clear_my_data', async () => {
  const phone = nextPhone();
  createdPhones.push(phone);

  await supabaseAdmin.from('users').insert({ phone, trust_score: 80 });
  const vendor = await createTestVendor({ is_active: false });
  createdVendorIds.push(vendor.id);

  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: phone,
      device_id: DEVICE_ID,
      message: `CMD-01 order ${TEST_SESSION}`,
      status: 'sent',
    })
    .select('id')
    .single();
  expect(reqErr).toBeNull();
  createdRequestIds.push(req!.id);

  const { error: billErr } = await supabaseAdmin.from('order_bills').insert({
    request_id: req!.id,
    vendor_id: vendor.id,
    user_phone: phone,
    total_amount: 250,
    payment_status: 'unpaid',
  });
  expect(billErr).toBeNull();

  await invokeClearMyData(phone);

  const { data: orderRow } = await supabaseAdmin
    .from('requests')
    .select('id, user_phone, message')
    .eq('id', req!.id)
    .single();
  expect(orderRow?.user_phone).toBe(phone);
  expect(orderRow?.message).toContain('CMD-01');

  const { count: billCount } = await supabaseAdmin
    .from('order_bills')
    .select('id', { count: 'exact', head: true })
    .eq('request_id', req!.id);
  expect(billCount).toBe(1);
});

test('CMD-02 — khata ledger survives clear_my_data', async () => {
  const phone = nextPhone();
  createdPhones.push(phone);

  await supabaseAdmin.from('users').insert({ phone });
  const vendor = await createTestVendor({ is_active: false });
  createdVendorIds.push(vendor.id);

  const { error: ledgerErr } = await supabaseAdmin.from('khata_ledger').insert({
    vendor_id: vendor.id,
    user_phone: phone,
    total_outstanding: 120,
  });
  expect(ledgerErr).toBeNull();

  await invokeClearMyData(phone);

  const { data: ledger } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('user_phone', phone)
    .maybeSingle();
  expect(Number(ledger?.total_outstanding)).toBe(120);
});

test('CMD-03 — notifications, addresses, app_users, saved_vendors are cleared', async () => {
  const phone = nextPhone();
  createdPhones.push(phone);

  await supabaseAdmin.from('users').insert({ phone });
  await supabaseAdmin.from('app_users').insert({
    phone,
    name: 'CMD User',
    lang: 'hi',
    feed_discovery_radius_km: 8,
  });
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: phone,
    type: 'test',
    title: 'Hello',
    body: 'World',
    route: 'home',
  });
  await supabaseAdmin.from('user_addresses').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    label: 'Home',
    address_text: '123 CMD Lane',
    is_default: true,
  });
  await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: DEVICE_ID,
    fcm_token: `fcm_${phone}`,
  });
  const vendor = await createTestVendor({ is_active: false });
  createdVendorIds.push(vendor.id);
  await supabaseAdmin.from('saved_vendors').insert({
    user_phone: phone,
    vendor_id: vendor.id,
    category: vendor.category,
    nickname: 'Neighbour',
  });
  await supabaseAdmin.from('saved_vendor_removal_notices').insert({
    user_phone: phone,
    shop_name: 'Removed Shop',
    reason: 'account_deleted',
  });

  await invokeClearMyData(phone);

  const checks = await Promise.all([
    supabaseAdmin.from('user_notifications').select('id').eq('user_phone', phone),
    supabaseAdmin.from('user_addresses').select('id').eq('user_phone', phone),
    supabaseAdmin.from('user_devices').select('id').eq('user_phone', phone),
    supabaseAdmin.from('app_users').select('phone').eq('phone', phone),
    supabaseAdmin.from('saved_vendors').select('id').eq('user_phone', phone),
    supabaseAdmin.from('saved_vendor_removal_notices').select('id').eq('user_phone', phone),
  ]);
  for (const { data } of checks) {
    expect(data ?? []).toHaveLength(0);
  }
});

test('CMD-04 — review text cleared but rating row retained; user_flags and ban standing kept', async () => {
  const phone = nextPhone();
  createdPhones.push(phone);

  await supabaseAdmin.from('users').insert({
    phone,
    is_banned: true,
    warn_count: 2,
    trust_score: 10,
  });

  const vendor = await createTestVendor({ is_active: false });
  createdVendorIds.push(vendor.id);

  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: phone,
      device_id: DEVICE_ID,
      message: 'CMD-04 review order',
      status: 'completed',
    })
    .select('id')
    .single();
  expect(reqErr).toBeNull();
  createdRequestIds.push(req!.id);

  await supabaseAdmin.from('vendor_reviews').insert({
    vendor_id: vendor.id,
    request_id: req!.id,
    user_phone: phone,
    rating: 4,
    review_text: 'Great service from CMD test',
  });

  await supabaseAdmin.from('user_flags').insert({
    request_id: req!.id,
    vendor_id: vendor.id,
    user_phone: phone,
    flag_type: 'noshow',
    notes: 'Did not answer door',
  });

  await invokeClearMyData(phone);

  const { data: review } = await supabaseAdmin
    .from('vendor_reviews')
    .select('rating, review_text')
    .eq('request_id', req!.id)
    .single();
  expect(review?.rating).toBe(4);
  expect(review?.review_text).toBeNull();

  const { data: flag } = await supabaseAdmin
    .from('user_flags')
    .select('flag_type, user_phone')
    .eq('request_id', req!.id)
    .single();
  expect(flag?.user_phone).toBe(phone);
  expect(flag?.flag_type).toBe('noshow');

  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('is_banned, warn_count, trust_score, phone')
    .eq('phone', phone)
    .single();
  expect(userRow?.phone).toBe(phone);
  expect(userRow?.is_banned).toBe(true);
  expect(userRow?.warn_count).toBe(2);
  expect(userRow?.trust_score).toBe(10);
});

test('CMD-05 — feed content cleared and vendor FCM tokens removed', async () => {
  const phone = nextPhone();
  createdPhones.push(phone);

  await supabaseAdmin.from('users').insert({ phone });
  const vendor = await createTestVendor({ phone, is_active: false });
  createdVendorIds.push(vendor.id);
  await ensureVendorGoLivePhotos(vendor.id);

  await supabaseAdmin.from('vendors').update({ fcm_token: 'vendor-fcm-token-cmd' }).eq('id', vendor.id);
  await supabaseAdmin.from('vendor_devices').insert({
    vendor_id: vendor.id,
    device_id: 'cmd-device-1',
    fcm_token: 'vendor-fcm-token-cmd',
  });

  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'announcement',
      user_phone: phone,
      content: 'Neighbourhood announcement CMD',
      lat: 18.52,
      lng: 73.85,
    })
    .select('id, content, lat, lng')
    .single();
  expect(postErr).toBeNull();
  createdPostIds.push(post!.id);

  await supabaseAdmin.from('feed_replies').insert({
    post_id: post!.id,
    user_phone: phone,
    content: 'Reply to keep',
  });
  await supabaseAdmin.from('feed_flags').insert({
    post_id: post!.id,
    flagged_by_phone: phone,
    reason: 'spam',
  });

  await invokeClearMyData(phone);

  const { data: clearedPost } = await supabaseAdmin
    .from('feed_posts')
    .select('content, lat, lng, image_url')
    .eq('id', post!.id)
    .single();
  expect(clearedPost?.content).toBe('Post cleared');
  expect(clearedPost?.lat).toBeNull();
  expect(clearedPost?.lng).toBeNull();

  const { data: clearedReply } = await supabaseAdmin
    .from('feed_replies')
    .select('content')
    .eq('post_id', post!.id)
    .single();
  expect(clearedReply?.content).toBe('Reply cleared');

  const { count: flagCount } = await supabaseAdmin
    .from('feed_flags')
    .select('id', { count: 'exact', head: true })
    .eq('post_id', post!.id);
  expect(flagCount).toBe(0);

  const { data: vendorRow } = await supabaseAdmin
    .from('vendors')
    .select('fcm_token')
    .eq('id', vendor.id)
    .single();
  expect(vendorRow?.fcm_token).toBeNull();

  const { count: deviceCount } = await supabaseAdmin
    .from('vendor_devices')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', vendor.id);
  expect(deviceCount).toBe(0);
});

test('CMD-06 — vendor go-live blocked without photos; succeeds after ensureVendorGoLivePhotos', async () => {
  const vendor = await createTestVendor({ is_active: false });
  createdVendorIds.push(vendor.id);

  await supabaseAdmin
    .from('vendors')
    .update({ photo_selfie: null, shop_photo_url: null })
    .eq('id', vendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ shop_photo_url: null })
    .eq('vendor_id', vendor.id);

  const { error: blocked } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { is_active: true },
  });
  expect(blocked).not.toBeNull();
  expect(blocked?.message).toContain('vendor_photos_required');

  await ensureVendorGoLivePhotos(vendor.id);

  const { error: allowed } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { is_active: true },
  });
  expect(allowed, allowed?.message).toBeNull();

  await assertVendorField(vendor.id, 'is_active', true);
});

async function assertVendorField(vendorId: string, field: string, value: unknown) {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .select(field)
    .eq('id', vendorId)
    .single();
  expect(error).toBeNull();
  expect((data as Record<string, unknown>)?.[field]).toEqual(value);
}
