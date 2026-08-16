import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
} from './helpers/setup';
import { offerMatchesFeedCategory } from '../src/lib/feedCategoryMatch';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdPostIds: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

test.afterAll(async () => {
  for (const id of createdPostIds) {
    await supabaseAdmin.from('feed_posts').delete().eq('id', id);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('feed_posts').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_menu_items').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_category_cancel_reasons').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('PBO-01 — per-business offers: independent slots with business lat/reach', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99101');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBO Offer Owner',
      shop_name: `!PBO-OFFER-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 99,
      vendor_note: 'Account-level note should not be used for offers',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  const elecLat = 18.521;
  const elecLng = 73.857;
  const plumLat = 18.522;
  const plumLng = 73.858;

  await supabaseAdmin
    .from('vendor_categories')
    .update({
      latitude: elecLat,
      longitude: elecLng,
      service_radius_km: 3,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({
      latitude: plumLat,
      longitude: plumLng,
      service_radius_km: 7,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  const starts = new Date(Date.now() - 60_000).toISOString();
  const ends = new Date(Date.now() + 7 * 86400_000).toISOString();

  const { error: offerA } = await supabaseAdmin.rpc('vendor_post_offer', {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_content: `PBO-ELEC-${T}`,
    p_starts_at: starts,
    p_expires_at: ends,
    p_lat: null,
    p_lng: null,
    p_reach_radius_km: 5,
    p_target_audience: 'customers',
    p_business_category_id: electrician.id,
  });
  expect(offerA, offerA?.message).toBeNull();

  const { error: offerB } = await supabaseAdmin.rpc('vendor_post_offer', {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_content: `PBO-PLUM-${T}`,
    p_starts_at: starts,
    p_expires_at: ends,
    p_lat: null,
    p_lng: null,
    p_reach_radius_km: 5,
    p_target_audience: 'customers',
    p_business_category_id: plumber.id,
  });
  expect(offerB, offerB?.message).toBeNull();

  const { data: posts } = await supabaseAdmin
    .from('feed_posts')
    .select('id, content, lat, lng, reach_radius_km, business_category_id, is_hidden')
    .eq('vendor_id', vendor.id)
    .eq('type', 'offer')
    .eq('is_hidden', false);

  const elecPost = posts?.find((p) => p.content === `PBO-ELEC-${T}`);
  const plumPost = posts?.find((p) => p.content === `PBO-PLUM-${T}`);
  expect(elecPost?.business_category_id).toBe(electrician.id);
  expect(plumPost?.business_category_id).toBe(plumber.id);
  expect(Number(elecPost?.lat)).toBeCloseTo(elecLat, 4);
  expect(Number(elecPost?.lng)).toBeCloseTo(elecLng, 4);
  expect(Number(elecPost?.reach_radius_km)).toBe(3);
  expect(Number(plumPost?.lat)).toBeCloseTo(plumLat, 4);
  expect(Number(plumPost?.lng)).toBeCloseTo(plumLng, 4);
  expect(Number(plumPost?.reach_radius_km)).toBe(7);

  for (const p of posts ?? []) createdPostIds.push(p.id);

  const { data: feedJson, error: feedErr } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_limit: 50,
    p_reader_radius_km: 50,
    p_reader_vendor_id: null,
    p_cursor_created_at: null,
    p_cursor_id: null,
  });
  expect(feedErr, feedErr?.message).toBeNull();
  const feedPosts = (feedJson as unknown[]) ?? [];
  const elecInFeed = feedPosts.find(
    (row) => (row as { content?: string }).content === `PBO-ELEC-${T}`,
  ) as { lat?: number; reach_radius_km?: number } | undefined;
  const plumInFeed = feedPosts.find(
    (row) => (row as { content?: string }).content === `PBO-PLUM-${T}`,
  ) as { lat?: number; reach_radius_km?: number } | undefined;
  expect(elecInFeed).toBeTruthy();
  expect(plumInFeed).toBeTruthy();
  expect(Number(elecInFeed?.lat)).toBeCloseTo(elecLat, 4);
  expect(Number(elecInFeed?.reach_radius_km)).toBe(3);
  expect(Number(plumInFeed?.lat)).toBeCloseTo(plumLat, 4);
  expect(Number(plumInFeed?.reach_radius_km)).toBe(7);
});

test('PBO-02 — posting a new offer hides prior offer for same business only', async () => {
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99102');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBO Replace Owner',
      shop_name: `!PBO-REPLACE-${T}`,
      phone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, plumber);
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ latitude: PUNE.lat, longitude: PUNE.lng, service_radius_km: 5 })
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  const starts = new Date(Date.now() - 60_000).toISOString();
  const ends = new Date(Date.now() + 7 * 86400_000).toISOString();

  const postOffer = async (content: string) => {
    const { error: rpcErr } = await supabaseAdmin.rpc('vendor_post_offer', {
      p_vendor_id: vendor.id,
      p_vendor_phone: phone,
      p_content: content,
      p_starts_at: starts,
      p_expires_at: ends,
      p_lat: null,
      p_lng: null,
      p_reach_radius_km: 5,
      p_target_audience: 'customers',
      p_business_category_id: plumber.id,
    });
    expect(rpcErr, rpcErr?.message).toBeNull();
  };

  await postOffer(`PBO-FIRST-${T}`);
  await postOffer(`PBO-SECOND-${T}`);

  const { data: posts } = await supabaseAdmin
    .from('feed_posts')
    .select('id, content, is_hidden')
    .eq('vendor_id', vendor.id)
    .like('content', `PBO-%${T}`);

  const first = posts?.find((p) => p.content === `PBO-FIRST-${T}`);
  const second = posts?.find((p) => p.content === `PBO-SECOND-${T}`);
  expect(first?.is_hidden).toBe(true);
  expect(second?.is_hidden).toBe(false);
  for (const p of posts ?? []) createdPostIds.push(p.id);
});

test('PBO-03 — offerMatchesFeedCategory prefers business_category_id', () => {
  const labels = new Map<string, Set<string>>();
  labels.set('v1', new Set(['Electrician', 'Plumber']));
  expect(
    offerMatchesFeedCategory(
      {
        vendor_id: 'v1',
        business_category_id: 'cat-plumber',
        vendors: { category: 'Electrician' },
      },
      'cat-plumber',
      'Plumber',
      labels,
    ),
  ).toBe(true);
  expect(
    offerMatchesFeedCategory(
      {
        vendor_id: 'v1',
        business_category_id: 'cat-plumber',
        vendors: { category: 'Electrician' },
      },
      'cat-electrician',
      'Electrician',
      labels,
    ),
  ).toBe(false);
});

test('PBO-04 — per-business vendor_note stored separately from account note', async () => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone('99103');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'PBO Note Owner',
      shop_name: `!PBO-NOTE-${T}`,
      phone,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
      vendor_note: 'WRONG ACCOUNT NOTE',
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, electrician, { is_primary: true });
  await seedVendorCategory(vendor.id, plumber, { is_primary: false });
  await seedDefaultVendorVerification(vendor.id);

  const elecNote = `Elec note ${T}`;
  const plumNote = `Plumb note ${T}`;

  await supabaseAdmin
    .from('vendor_categories')
    .update({ vendor_note: elecNote })
    .eq('vendor_id', vendor.id)
    .eq('category_id', electrician.id);

  await supabaseAdmin
    .from('vendor_categories')
    .update({ vendor_note: plumNote })
    .eq('vendor_id', vendor.id)
    .eq('category_id', plumber.id);

  const { data: rows } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id, vendor_note')
    .eq('vendor_id', vendor.id);

  const elecRow = rows?.find((r) => r.category_id === electrician.id);
  const plumRow = rows?.find((r) => r.category_id === plumber.id);
  expect(elecRow?.vendor_note).toBe(elecNote);
  expect(plumRow?.vendor_note).toBe(plumNote);

  const { data: account } = await supabaseAdmin
    .from('vendors')
    .select('vendor_note')
    .eq('id', vendor.id)
    .single();
  expect(account?.vendor_note).toBe('WRONG ACCOUNT NOTE');
});
