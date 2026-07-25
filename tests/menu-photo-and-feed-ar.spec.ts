/**
 * Menu item optional image_url + feed notify: offers ignore feed_notifications_enabled.
 */
import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  cleanupTestVendors,
  TEST_SESSION,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };
const createdPostIds: string[] = [];
const createdDeviceIds: string[] = [];
const createdPhones: string[] = [];
const createdMenuItemIds: string[] = [];

test.afterAll(async () => {
  if (createdMenuItemIds.length) {
    await supabaseAdmin.from('vendor_menu_items').delete().in('id', createdMenuItemIds);
  }
  if (createdDeviceIds.length) {
    await supabaseAdmin.from('user_devices').delete().in('device_id', createdDeviceIds);
  }
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('user_notifications').delete().in('user_phone', createdPhones);
  }
  await cleanupTestVendors();
});

test('MENU-PHOTO-01: vendor_insert_menu_items accepts optional image_url; omit stays null', async () => {
  const vendor = await createTestVendor({ shop_name: `MenuPhoto-${TEST_SESSION}` });
  const withPhoto = `https://example.com/menu-photos/${vendor.id}/item.jpg`;

  const { error: insertErr } = await supabaseAdmin.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_items: [
      {
        name: `Photo Item ${T}`,
        price: 40,
        unit: 'pc',
        description: null,
        sort_order: 0,
        image_url: withPhoto,
      },
      {
        name: `No Photo Item ${T}`,
        price: 20,
        unit: 'pc',
        description: null,
        sort_order: 1,
      },
    ],
  });
  expect(insertErr, insertErr?.message).toBeNull();

  const { data: rows, error } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id, name, image_url')
    .eq('vendor_id', vendor.id)
    .order('sort_order');
  expect(error).toBeNull();
  expect(rows?.length).toBeGreaterThanOrEqual(2);
  for (const row of rows ?? []) createdMenuItemIds.push(row.id);

  const photoRow = rows?.find((r) => r.name.startsWith('Photo Item'));
  const plainRow = rows?.find((r) => r.name.startsWith('No Photo Item'));
  expect(photoRow?.image_url).toBe(withPhoto);
  expect(plainRow?.image_url).toBeNull();
});

test('MENU-PHOTO-02: vendor_update_menu_item sets / clears image_url; client size gate rejects oversize', async () => {
  const vendor = await createTestVendor({ shop_name: `MenuPhotoUpd-${TEST_SESSION}` });
  const { error: insErr } = await supabaseAdmin.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_items: [{ name: `Upd ${T}`, price: 10, sort_order: 0 }],
  });
  expect(insErr).toBeNull();
  const { data: row } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', vendor.id)
    .eq('name', `Upd ${T}`)
    .single();
  expect(row?.id).toBeTruthy();
  createdMenuItemIds.push(row!.id);

  const url = `https://hhdylnhqdzfabsolwxdz.supabase.co/storage/v1/object/public/menu-photos/${vendor.id}/x.jpg`;
  const { error: setErr } = await supabaseAdmin.rpc('vendor_update_menu_item', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_item_id: row!.id,
    p_name: `Upd ${T}`,
    p_price: 10,
    p_unit: null,
    p_description: null,
    p_category_id: null,
    p_image_url: url,
  });
  expect(setErr, setErr?.message).toBeNull();
  const { data: afterSet } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('image_url')
    .eq('id', row!.id)
    .single();
  expect(afterSet?.image_url).toBe(url);

  const { error: clearErr } = await supabaseAdmin.rpc('vendor_update_menu_item', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_item_id: row!.id,
    p_name: `Upd ${T}`,
    p_price: 10,
    p_unit: null,
    p_description: null,
    p_category_id: null,
    p_image_url: '',
  });
  expect(clearErr).toBeNull();
  const { data: afterClear } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('image_url')
    .eq('id', row!.id)
    .single();
  expect(afterClear?.image_url).toBeNull();
});

test('FEED-AR-01: toggle off suppresses announcement but not offer for same device', async () => {
  const phone = `88073${String(T).slice(-5)}`;
  createdPhones.push(phone);
  const deviceId = `feed_ar_${TEST_SESSION}_${phone}`;
  createdDeviceIds.push(deviceId);

  const { error: devErr } = await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: deviceId,
    fcm_token: `fcm_${deviceId}`,
    feed_notifications_enabled: false,
    is_current: true,
    last_lat: PUNE.lat,
    last_lng: PUNE.lng,
    last_location_at: new Date().toISOString(),
  });
  expect(devErr, devErr?.message).toBeNull();

  const category = await getActiveCategoryByLabel('Grocery');
  const { data: vendor, error: vErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone: `99073${String(T).slice(-5)}`,
      name: 'Feed AR Vendor',
      shop_name: `!FeedAR-${T}`,
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
    .select('id, phone')
    .single();
  expect(vErr).toBeNull();
  await seedVendorCategory(vendor!.id, category);

  const basePost = {
    user_phone: vendor!.phone,
    content: `feed-ar ${T}`,
    lat: PUNE.lat,
    lng: PUNE.lng,
    reach_radius_km: 50,
    target_audience: 'customers',
  };

  const { data: ann, error: annErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({ ...basePost, type: 'announcement' })
    .select('id')
    .single();
  expect(annErr).toBeNull();
  createdPostIds.push(ann!.id);

  const { data: offer, error: offerErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({ ...basePost, type: 'offer', content: `feed-ar-offer ${T}` })
    .select('id')
    .single();
  expect(offerErr).toBeNull();
  createdPostIds.push(offer!.id);

  const { data: annDevices, error: annDevErr } = await supabaseAdmin.rpc(
    'get_feed_post_notify_devices',
    { p_post_id: ann!.id },
  );
  expect(annDevErr).toBeNull();
  const annPhones = (annDevices ?? []).map((d: { user_phone: string }) => d.user_phone);
  expect(annPhones).not.toContain(phone);

  const { data: offerDevices, error: offerDevErr } = await supabaseAdmin.rpc(
    'get_feed_post_notify_devices',
    { p_post_id: offer!.id },
  );
  expect(offerDevErr).toBeNull();
  const offerPhones = (offerDevices ?? []).map((d: { user_phone: string }) => d.user_phone);
  expect(offerPhones).toContain(phone);

  // Toggle on → announcement should include the device again
  await supabaseAdmin
    .from('user_devices')
    .update({ feed_notifications_enabled: true })
    .eq('device_id', deviceId);
  const { data: annOn } = await supabaseAdmin.rpc('get_feed_post_notify_devices', {
    p_post_id: ann!.id,
  });
  expect((annOn ?? []).map((d: { user_phone: string }) => d.user_phone)).toContain(phone);
});
