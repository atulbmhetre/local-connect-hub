/**
 * Feed notify audience targeting + create RPC rate limits.
 * Uses get_feed_post_notify_devices (same helper as get_local_feed_posts).
 */
import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };

const createdPostIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdDeviceIds: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '880' | '990'): string {
  phoneSeq += 1;
  const phone = `${prefix}72${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function cleanupRateLimitRows(
  functionName: string,
  identifierType: string,
  identifier: string,
) {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', functionName)
    .eq('identifier_type', identifierType)
    .eq('identifier', identifier);
}

async function seedNearbyDevice(opts: {
  phone: string;
  deviceSuffix: string;
  lat?: number;
  lng?: number;
}) {
  const deviceId = `feed_notify_${opts.deviceSuffix}_${TEST_SESSION}_${opts.phone}`;
  createdDeviceIds.push(deviceId);
  const { error } = await supabaseAdmin.from('user_devices').insert({
    user_phone: opts.phone,
    device_id: deviceId,
    fcm_token: `fcm_${deviceId}`,
    feed_notifications_enabled: true,
    last_lat: opts.lat ?? PUNE.lat,
    last_lng: opts.lng ?? PUNE.lng,
    last_location_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function seedVendor(opts: {
  phone: string;
  shop: string;
  categoryLabel: string;
}) {
  const category = await getActiveCategoryByLabel(opts.categoryLabel);
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone: opts.phone,
      name: `FN ${opts.shop}`,
      shop_name: `!FN-${opts.shop}-${T}`,
      category: category.label,
      service_mode: category.service_mode,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);
  return { vendorId: vendor.id as string, category };
}

test.afterAll(async () => {
  if (createdDeviceIds.length) {
    await supabaseAdmin.from('user_devices').delete().in('device_id', createdDeviceIds);
  }
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('feed_posts').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('user_notifications').delete().in('user_phone', createdPhones);
    await supabaseAdmin.from('user_devices').delete().in('user_phone', createdPhones);
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
    await supabaseAdmin.from('app_users').delete().in('phone', createdPhones);
  }
});

test('FN-AUD-01 — vendors-only offer: notify devices exclude customers, include vendors', async () => {
  const authorPhone = nextPhone('990');
  const customerPhone = nextPhone('880');
  const vendorPhone = nextPhone('990');

  const { vendorId: posterId } = await seedVendor({
    phone: authorPhone,
    shop: 'Poster',
    categoryLabel: 'Grocery',
  });
  await seedVendor({
    phone: vendorPhone,
    shop: 'Reader',
    categoryLabel: 'Grocery',
  });

  await seedNearbyDevice({ phone: customerPhone, deviceSuffix: 'cust' });
  await seedNearbyDevice({ phone: vendorPhone, deviceSuffix: 'vend' });

  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: posterId,
      user_phone: authorPhone,
      content: `FN-vendors-only-${T}`,
      lat: PUNE.lat,
      lng: PUNE.lng,
      reach_radius_km: 50,
      target_audience: 'vendors',
      target_category_id: null,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      is_hidden: false,
    })
    .select('id')
    .single();
  expect(postErr).toBeNull();
  createdPostIds.push(post!.id);

  const { data: devices, error } = await supabaseAdmin.rpc('get_feed_post_notify_devices', {
    p_post_id: post!.id,
    p_radius_km: 25,
    p_author_phone: authorPhone,
  });
  expect(error, error?.message).toBeNull();

  const phones = (devices ?? []).map((d: { user_phone: string }) => d.user_phone);
  expect(phones).toContain(vendorPhone);
  expect(phones).not.toContain(customerPhone);
  expect(phones).not.toContain(authorPhone);
});

test('FN-AUD-02 — category-scoped offer: pharmacy vendor in, grocery vendor out', async () => {
  const authorPhone = nextPhone('990');
  const pharmacyPhone = nextPhone('990');
  const groceryPhone = nextPhone('990');

  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const { vendorId: posterId } = await seedVendor({
    phone: authorPhone,
    shop: 'CatPoster',
    categoryLabel: 'Grocery',
  });
  await seedVendor({
    phone: pharmacyPhone,
    shop: 'PharmReader',
    categoryLabel: 'Pharmacy',
  });
  await seedVendor({
    phone: groceryPhone,
    shop: 'GrocReader',
    categoryLabel: 'Grocery',
  });

  await seedNearbyDevice({ phone: pharmacyPhone, deviceSuffix: 'pharm' });
  await seedNearbyDevice({ phone: groceryPhone, deviceSuffix: 'groc' });

  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: posterId,
      user_phone: authorPhone,
      content: `FN-pharmacy-only-${T}`,
      lat: PUNE.lat,
      lng: PUNE.lng,
      reach_radius_km: 50,
      target_audience: 'vendors',
      target_category_id: pharmacy.id,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      is_hidden: false,
    })
    .select('id')
    .single();
  expect(postErr).toBeNull();
  createdPostIds.push(post!.id);

  const { data: devices, error } = await supabaseAdmin.rpc('get_feed_post_notify_devices', {
    p_post_id: post!.id,
    p_radius_km: 25,
    p_author_phone: authorPhone,
  });
  expect(error, error?.message).toBeNull();

  const phones = (devices ?? []).map((d: { user_phone: string }) => d.user_phone);
  expect(phones).toContain(pharmacyPhone);
  expect(phones).not.toContain(groceryPhone);
});

test('FN-AUD-03 — audience helper matches get_local_feed_posts visibility for same reader', async () => {
  const authorPhone = nextPhone('990');
  const customerPhone = nextPhone('880');
  const vendorPhone = nextPhone('990');

  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const { vendorId: posterId } = await seedVendor({
    phone: authorPhone,
    shop: 'ParityPoster',
    categoryLabel: 'Grocery',
  });
  const { vendorId: readerVendorId } = await seedVendor({
    phone: vendorPhone,
    shop: 'ParityReader',
    categoryLabel: 'Pharmacy',
  });

  const content = `FN-parity-${T}`;
  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: posterId,
      user_phone: authorPhone,
      content,
      lat: PUNE.lat,
      lng: PUNE.lng,
      reach_radius_km: 50,
      target_audience: 'vendors',
      target_category_id: pharmacy.id,
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
      is_hidden: false,
    })
    .select('id')
    .single();
  expect(postErr).toBeNull();
  createdPostIds.push(post!.id);

  await seedNearbyDevice({ phone: customerPhone, deviceSuffix: 'parity_c' });
  await seedNearbyDevice({ phone: vendorPhone, deviceSuffix: 'parity_v' });

  const { data: customerFeed } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 50,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
  });
  const customerSees = (customerFeed as { content?: string }[] | null)?.some(
    (p) => p.content === content,
  );

  const { data: vendorFeed } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 50,
    p_reader_radius_km: 50,
    p_reader_vendor_id: readerVendorId,
  });
  const vendorSees = (vendorFeed as { content?: string }[] | null)?.some(
    (p) => p.content === content,
  );

  const { data: devices } = await supabaseAdmin.rpc('get_feed_post_notify_devices', {
    p_post_id: post!.id,
    p_radius_km: 50,
    p_author_phone: authorPhone,
  });
  const phones = (devices ?? []).map((d: { user_phone: string }) => d.user_phone);

  expect(customerSees).toBe(false);
  expect(phones).not.toContain(customerPhone);
  expect(vendorSees).toBe(true);
  expect(phones).toContain(vendorPhone);
});

test('FN-RL-01 — submit_customer_feed_post: 5 succeed, 6th within 10 min is rate_limited', async () => {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  await cleanupRateLimitRows('submit_customer_feed_post', 'phone', phone);

  try {
    for (let i = 0; i < 5; i++) {
      const { data: postId, error } = await supabaseAdmin.rpc('submit_customer_feed_post', {
        p_user_phone: phone,
        p_type: 'announcement',
        p_content: `FN-RL-cust-${i}-${T}`,
        p_lat: PUNE.lat,
        p_lng: PUNE.lng,
        p_reach_radius_km: 5,
      });
      expect(error, error?.message).toBeNull();
      expect(postId).toBeTruthy();
      createdPostIds.push(postId as string);
    }

    const sixth = await supabaseAdmin.rpc('submit_customer_feed_post', {
      p_user_phone: phone,
      p_type: 'announcement',
      p_content: `FN-RL-cust-blocked-${T}`,
      p_lat: PUNE.lat,
      p_lng: PUNE.lng,
      p_reach_radius_km: 5,
    });
    expect(sixth.error).toBeTruthy();
    expect(sixth.error!.message).toContain('rate_limited');
  } finally {
    await cleanupRateLimitRows('submit_customer_feed_post', 'phone', phone);
  }
});

test('FN-RL-02 — vendor_post_offer: 5 succeed, 6th within 10 min is rate_limited', async () => {
  const phone = nextPhone('990');
  const { vendorId } = await seedVendor({
    phone,
    shop: 'RLOffer',
    categoryLabel: 'Grocery',
  });
  await cleanupRateLimitRows('vendor_post_offer', 'vendor_id', vendorId);

  const starts = new Date(Date.now() - 60_000).toISOString();
  const ends = new Date(Date.now() + 7 * 86400_000).toISOString();

  try {
    for (let i = 0; i < 5; i++) {
      const { error } = await supabaseAdmin.rpc('vendor_post_offer', {
        p_vendor_id: vendorId,
        p_vendor_phone: phone,
        p_content: `FN-RL-offer-${i}-${T}`,
        p_starts_at: starts,
        p_expires_at: ends,
        p_lat: PUNE.lat,
        p_lng: PUNE.lng,
        p_reach_radius_km: 5,
        p_target_audience: 'customers',
      });
      expect(error, error?.message).toBeNull();
    }

    const { data: posts } = await supabaseAdmin
      .from('feed_posts')
      .select('id')
      .eq('vendor_id', vendorId)
      .like('content', `FN-RL-offer-%-${T}`);
    for (const p of posts ?? []) createdPostIds.push(p.id);

    const sixth = await supabaseAdmin.rpc('vendor_post_offer', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_content: `FN-RL-offer-blocked-${T}`,
      p_starts_at: starts,
      p_expires_at: ends,
      p_lat: PUNE.lat,
      p_lng: PUNE.lng,
      p_reach_radius_km: 5,
      p_target_audience: 'customers',
    });
    expect(sixth.error).toBeTruthy();
    expect(sixth.error!.message).toContain('rate_limited');
  } finally {
    await cleanupRateLimitRows('vendor_post_offer', 'vendor_id', vendorId);
  }
});
