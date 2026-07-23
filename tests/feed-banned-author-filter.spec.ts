/**
 * Regression: get_local_feed_posts / get_local_feed_posts_count must exclude
 * posts authored by banned vendors (same rule as vendors_public_discoverable_read).
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
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

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(opts: {
  shop: string;
  is_banned?: boolean;
}): Promise<{ id: string; phone: string }> {
  const cat = await getActiveCategoryByLabel('Grocery');
  const phone = nextPhone('99081');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Feed Ban Filter',
      shop_name: `!FBAN-${opts.shop}-${T}`,
      phone,
      category: cat.label,
      service_mode: 'delivery',
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
      is_banned: opts.is_banned ?? false,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return { id: data.id as string, phone: data.phone as string };
}

async function seedOfferPost(
  vendorId: string,
  vendorPhone: string,
  content: string,
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: vendorId,
      user_phone: vendorPhone,
      content,
      lat: PUNE.lat,
      lng: PUNE.lng,
      reach_radius_km: 50,
      target_audience: 'customers',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdPostIds.push(data.id);
  return data.id as string;
}

test.afterEach(async () => {
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
    createdPostIds.length = 0;
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  createdVendorIds.length = 0;
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
    createdPhones.length = 0;
  }
});

test('FEED-BAN-01 — get_local_feed_posts excludes banned-vendor offers; keeps non-banned', async () => {
  const ok = await seedVendor({ shop: 'ok' });
  const banned = await seedVendor({ shop: 'banned', is_banned: true });
  const okPostId = await seedOfferPost(ok.id, ok.phone, `FBAN ok ${T}`);
  const bannedPostId = await seedOfferPost(banned.id, banned.phone, `FBAN banned ${T}`);

  const { data, error } = await supabase.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 50,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
  });
  expect(error, error?.message).toBeNull();

  const rows = (data ?? []) as Array<{ id: string }>;
  const ids = rows.map((r) => r.id);
  expect(ids).toContain(okPostId);
  expect(ids).not.toContain(bannedPostId);
});

test('FEED-BAN-02 — get_local_feed_posts_count matches list exclusion for banned authors', async () => {
  const ok = await seedVendor({ shop: 'cnt-ok' });
  const banned = await seedVendor({ shop: 'cnt-banned', is_banned: true });
  await seedOfferPost(ok.id, ok.phone, `FBAN cnt ok ${T}`);
  await seedOfferPost(banned.id, banned.phone, `FBAN cnt banned ${T}`);

  const { data: beforeBanToggle, error: countErr } = await supabase.rpc(
    'get_local_feed_posts_count',
    {
      p_reader_lat: PUNE.lat,
      p_reader_lng: PUNE.lng,
      p_reader_radius_km: 50,
      p_reader_vendor_id: null,
    },
  );
  expect(countErr, countErr?.message).toBeNull();

  const { data: list } = await supabase.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 200,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
  });
  const listIds = new Set(((list ?? []) as Array<{ id: string }>).map((r) => r.id));

  // Count must not include the banned vendor's post (same filter as list).
  const { data: bannedPosts } = await supabaseAdmin
    .from('feed_posts')
    .select('id')
    .eq('vendor_id', banned.id);
  for (const row of bannedPosts ?? []) {
    expect(listIds.has(row.id)).toBe(false);
  }

  // Unban → both list and count should grow to include the previously hidden post.
  await supabaseAdmin.from('vendors').update({ is_banned: false }).eq('id', banned.id);

  const { data: afterList } = await supabase.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 200,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
  });
  const afterIds = new Set(((afterList ?? []) as Array<{ id: string }>).map((r) => r.id));
  for (const row of bannedPosts ?? []) {
    expect(afterIds.has(row.id)).toBe(true);
  }

  const { data: afterCount } = await supabase.rpc('get_local_feed_posts_count', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
  });
  expect(Number(afterCount)).toBeGreaterThanOrEqual(Number(beforeBanToggle) + 1);
});
