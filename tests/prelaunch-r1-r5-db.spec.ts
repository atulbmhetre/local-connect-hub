/**
 * R1–R5 requirement checks at the DB/RPC layer (no browser).
 * Titles describe the product rule, not the implementation path.
 */
import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };

const createdPostIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '880' | '990'): string {
  phoneSeq += 1;
  const phone = `${prefix}71${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

test.afterAll(async () => {
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('feed_posts').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
    await supabaseAdmin.from('app_users').delete().in('phone', createdPhones);
  }
});

test('R3-DB-01 — customer post that asks for vendors-only targeting is stored as customers-only', async () => {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });

  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const { data: postId, error } = await supabaseAdmin.rpc('submit_customer_feed_post', {
    p_user_phone: phone,
    p_type: 'announcement',
    p_content: `R3-bypass-attempt-${T}`,
    p_lat: PUNE.lat,
    p_lng: PUNE.lng,
    p_reach_radius_km: 5,
    p_target_audience: 'vendors',
    p_target_category_id: pharmacy.id,
  });
  expect(error).toBeNull();
  expect(postId).toBeTruthy();
  createdPostIds.push(postId as string);

  const { data: row } = await supabaseAdmin
    .from('feed_posts')
    .select('target_audience, target_category_id')
    .eq('id', postId)
    .single();

  expect(row?.target_audience).toBe('customers');
  expect(row?.target_category_id).toBeNull();
});

test('R4-DB-01 — customer post that asks for city-wide reach is stored at the modest cap (25 km)', async () => {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });

  const { data: postId, error } = await supabaseAdmin.rpc('submit_customer_feed_post', {
    p_user_phone: phone,
    p_type: 'announcement',
    p_content: `R4-bypass-reach-${T}`,
    p_lat: PUNE.lat,
    p_lng: PUNE.lng,
    p_reach_radius_km: 9999,
  });
  expect(error).toBeNull();
  expect(postId).toBeTruthy();
  createdPostIds.push(postId as string);

  const { data: row } = await supabaseAdmin
    .from('feed_posts')
    .select('reach_radius_km')
    .eq('id', postId)
    .single();

  expect(Number(row?.reach_radius_km)).toBe(25);
});

test('R3-DB-02 — get_local_feed_posts hides vendors-only offers from customers and shows them to vendors', async () => {
  const grocery = await getActiveCategoryByServiceMode('delivery');
  const posterPhone = nextPhone('990');
  const readerPhone = nextPhone('990');
  const customerPhone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });

  const { data: poster, error: posterErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'R3 Poster',
      shop_name: `!R3-POST-${T}`,
      phone: posterPhone,
      category: grocery.label,
      service_mode: 'delivery',
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
    })
    .select('id')
    .single();
  if (posterErr) throw posterErr;
  createdVendorIds.push(poster.id);
  await seedVendorCategory(poster.id, grocery);

  const { data: reader, error: readerErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'R3 Reader',
      shop_name: `!R3-READ-${T}`,
      phone: readerPhone,
      category: grocery.label,
      service_mode: 'delivery',
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
    })
    .select('id')
    .single();
  if (readerErr) throw readerErr;
  createdVendorIds.push(reader.id);
  await seedVendorCategory(reader.id, grocery);

  const content = `R3-vendors-only-offer-${T}`;
  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: poster.id,
      user_phone: posterPhone,
      content,
      lat: PUNE.lat,
      lng: PUNE.lng,
      locality: 'Pune',
      is_hidden: false,
      reach_radius_km: 9999,
      target_audience: 'vendors',
      target_category_id: null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();
  if (postErr) throw postErr;
  createdPostIds.push(post.id);

  const { data: asCustomer, error: custErr } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_reader_radius_km: 9999,
    p_reader_vendor_id: null,
  });
  expect(custErr).toBeNull();
  const customerContents = (Array.isArray(asCustomer) ? asCustomer : []).map(
    (p: { content?: string }) => p.content,
  );
  expect(customerContents).not.toContain(content);

  const { data: asVendor, error: vendErr } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_reader_radius_km: 9999,
    p_reader_vendor_id: reader.id,
  });
  expect(vendErr).toBeNull();
  const vendorContents = (Array.isArray(asVendor) ? asVendor : []).map(
    (p: { content?: string }) => p.content,
  );
  expect(vendorContents).toContain(content);
});

test('R3-DB-03 — Pharmacy-targeted offer is visible to Pharmacy vendors, not Grocery vendors', async () => {
  const pharmacy = await getActiveCategoryByLabel('Pharmacy');
  const grocery = await getActiveCategoryByLabel('Grocery');

  const posterPhone = nextPhone('990');
  const pharmPhone = nextPhone('990');
  const groceryPhone = nextPhone('990');

  async function seedVendor(tag: string, phone: string, cat: { id: string; label: string; service_mode: string }) {
    const { data, error } = await supabaseAdmin
      .from('vendors')
      .insert({
        name: `R3 ${tag}`,
        shop_name: `!R3-${tag}-${T}`,
        phone,
        category: cat.label,
        service_mode: cat.service_mode,
        latitude: PUNE.lat,
        longitude: PUNE.lng,
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
        discoverable: true,
      })
      .select('id')
      .single();
    if (error) throw error;
    createdVendorIds.push(data.id);
    await seedVendorCategory(data.id, cat);
    return data;
  }

  const poster = await seedVendor('PH-POST', posterPhone, pharmacy);
  const pharmReader = await seedVendor('PH-READ', pharmPhone, pharmacy);
  const groceryReader = await seedVendor('GR-READ', groceryPhone, grocery);

  const content = `R3-pharmacy-only-${T}`;
  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      type: 'offer',
      vendor_id: poster.id,
      user_phone: posterPhone,
      content,
      lat: PUNE.lat,
      lng: PUNE.lng,
      is_hidden: false,
      reach_radius_km: 9999,
      target_audience: 'vendors',
      target_category_id: pharmacy.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();
  if (postErr) throw postErr;
  createdPostIds.push(post.id);

  const { data: pharmFeed } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_reader_radius_km: 9999,
    p_reader_vendor_id: pharmReader.id,
  });
  expect(
    (Array.isArray(pharmFeed) ? pharmFeed : []).map((p: { content?: string }) => p.content),
  ).toContain(content);

  const { data: groceryFeed } = await supabaseAdmin.rpc('get_local_feed_posts', {
    p_reader_lat: PUNE.lat,
    p_reader_lng: PUNE.lng,
    p_reader_radius_km: 9999,
    p_reader_vendor_id: groceryReader.id,
  });
  expect(
    (Array.isArray(groceryFeed) ? groceryFeed : []).map((p: { content?: string }) => p.content),
  ).not.toContain(content);
});
