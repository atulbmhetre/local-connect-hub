import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

// Customer-side read hardening, final discovery-scan cleanup (OTP-off identity
// model). `supabase` is the anon-key client with NO Supabase Auth session —
// exactly how OTP-off production callers reach the DB. `supabaseAdmin` is
// seed/cleanup only.
// Covers: get_my_help_banner_orders / get_my_active_order_count /
// get_my_active_request_vendor_ids / get_my_fulfilled_request_ids /
// get_saved_vendors_count / get_my_feed_flags / get_my_addresses /
// should_notify_vendor_order_edit, the user_addresses world-read policy drop,
// fetchUserTrust via lookup_user_by_phone, and rate limiting.

const T = Date.now();
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [];
const createdPostIds: string[] = [];
const createdAddressIds: string[] = [];
const rlIdentifiers: string[] = [];
const RL_ACTIONS = [
  'get_my_help_banner_orders',
  'get_my_active_order_count',
  'get_my_active_request_vendor_ids',
  'get_my_fulfilled_request_ids',
  'get_saved_vendors_count',
  'get_my_feed_flags',
  'get_my_addresses',
  'should_notify_vendor_order_edit',
  'lookup_user_by_phone',
];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  rlIdentifiers.push(phone);
  return phone;
}

function trackDevice(deviceId: string): string {
  rlIdentifiers.push(deviceId);
  return deviceId;
}

async function seedVendor(shopName: string, serviceMode = 'delivery') {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Customer Read Vendor',
      shop_name: shopName,
      phone: nextPhone('99081'),
      category: cat.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return data.id as string;
}

async function seedRequest(
  vendorId: string,
  userPhone: string | null,
  deviceId: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: deviceId,
      message: `customer-read-${T}-${createdRequestIds.length}`,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

test.afterAll(async () => {
  for (const id of createdRequestIds) {
    await supabaseAdmin.from('user_notifications').delete().eq('related_id', id);
    await supabaseAdmin.from('requests').delete().eq('id', id);
  }
  for (const id of createdPostIds) {
    await supabaseAdmin.from('feed_flags').delete().eq('post_id', id);
    await supabaseAdmin.from('feed_posts').delete().eq('id', id);
  }
  for (const id of createdAddressIds) {
    await supabaseAdmin.from('user_addresses').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('saved_vendors').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  if (rlIdentifiers.length > 0) {
    for (const action of RL_ACTIONS) {
      await supabaseAdmin
        .from('edge_function_rate_limits')
        .delete()
        .eq('function_name', action)
        .in('identifier', rlIdentifiers);
    }
  }
});

test('CRH-01 — get_my_help_banner_orders: accepted orders in 48h window with vendor fields; direct read stays blocked', async () => {
  const helpVendorId = await seedVendor(`!CRH01-help-${T}`, 'help');
  const phone = nextPhone('88081');
  const device = trackDevice(`devCRH01_${T}`);

  const acceptedId = await seedRequest(helpVendorId, phone, device, { status: 'accepted' });
  // Accepted but stale (updated 3 days ago) — must be excluded by the window.
  // Set at INSERT time: the requests_set_updated_at trigger overwrites
  // updated_at on every UPDATE, so a post-insert update can't backdate it.
  const staleId = await seedRequest(helpVendorId, phone, device, {
    status: 'accepted',
    updated_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
  });
  // Sent (not accepted) — excluded.
  const sentId = await seedRequest(helpVendorId, phone, device);

  // Direct anon read still blocked (RLS untouched — this is the PROD bug).
  const direct = await supabase.from('requests').select('id').eq('user_phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_my_help_banner_orders', {
    p_user_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{
    id: string;
    vendor_shop_name: string | null;
    vendor_service_mode: string | null;
  }>;
  const ids = rows.map((r) => r.id);
  expect(ids).toContain(acceptedId);
  expect(ids).not.toContain(staleId);
  expect(ids).not.toContain(sentId);
  const row = rows.find((r) => r.id === acceptedId)!;
  expect(row.vendor_shop_name).toBe(`!CRH01-help-${T}`);
  expect(row.vendor_service_mode).toBe('help');

  // Missing identity → identity_required.
  const { error: noIdErr } = await supabase.rpc('get_my_help_banner_orders', {
    p_user_phone: '',
  });
  expect(noIdErr?.message ?? '').toContain('identity_required');
});

test('CRH-02 — get_my_active_order_count matches the user-role active window', async () => {
  const vendorId = await seedVendor(`!CRH02-${T}`);
  const phone = nextPhone('88082');
  const device = trackDevice(`devCRH02_${T}`);

  await seedRequest(vendorId, phone, device); // sent, fresh → counts
  await seedRequest(vendorId, phone, device, { status: 'fulfilled' }); // any age → counts
  await seedRequest(vendorId, phone, device, { status: 'done' }); // done → never counts
  const oldSeenId = await seedRequest(vendorId, phone, device, { status: 'seen' });
  await supabaseAdmin
    .from('requests')
    .update({ created_at: new Date(Date.now() - 30 * 3600 * 1000).toISOString() })
    .eq('id', oldSeenId); // seen older than 24h → excluded

  const { data, error } = await supabase.rpc('get_my_active_order_count', {
    p_user_phone: phone,
    p_device_id: device,
  });
  expect(error, error?.message).toBeNull();
  expect(data).toBe(2);

  // Device-only identity counts device-scoped rows.
  const deviceOnly = trackDevice(`devCRH02_only_${T}`);
  await seedRequest(vendorId, null, deviceOnly);
  const { data: devCount, error: devErr } = await supabase.rpc('get_my_active_order_count', {
    p_user_phone: null,
    p_device_id: deviceOnly,
  });
  expect(devErr, devErr?.message).toBeNull();
  expect(devCount).toBe(1);
});

test('CRH-03 — get_my_active_request_vendor_ids + get_my_fulfilled_request_ids scope correctly', async () => {
  const vendorA = await seedVendor(`!CRH03-A-${T}`);
  const vendorB = await seedVendor(`!CRH03-B-${T}`);
  const phone = nextPhone('88083');
  const device = trackDevice(`devCRH03_${T}`);

  await seedRequest(vendorA, phone, device); // sent → active
  const fulfilledId = await seedRequest(vendorB, phone, device, { status: 'fulfilled' });

  const { data: active, error: activeErr } = await supabase.rpc(
    'get_my_active_request_vendor_ids',
    { p_user_phone: phone, p_device_id: device, p_vendor_ids: [vendorA, vendorB] },
  );
  expect(activeErr, activeErr?.message).toBeNull();
  const activeIds = ((active ?? []) as Array<{ vendor_id: string }>).map((r) => r.vendor_id);
  expect(activeIds).toContain(vendorA);
  expect(activeIds).not.toContain(vendorB); // fulfilled is not sent/seen

  const { data: fulfilled, error: fulfilledErr } = await supabase.rpc(
    'get_my_fulfilled_request_ids',
    { p_user_phone: phone, p_device_id: device, p_vendor_ids: [vendorA, vendorB] },
  );
  expect(fulfilledErr, fulfilledErr?.message).toBeNull();
  const fulfilledRows = (fulfilled ?? []) as Array<{ id: string; vendor_id: string }>;
  expect(fulfilledRows.map((r) => r.vendor_id)).toEqual([vendorB]);
  expect(fulfilledRows[0].id).toBe(fulfilledId);

  // A stranger identity sees nothing for the same vendors.
  const stranger = trackDevice(`devCRH03_stranger_${T}`);
  const { data: strangerActive } = await supabase.rpc('get_my_active_request_vendor_ids', {
    p_user_phone: null,
    p_device_id: stranger,
    p_vendor_ids: [vendorA, vendorB],
  });
  expect(strangerActive ?? []).toEqual([]);
});

test('CRH-04 — get_saved_vendors_count counts phone OR device rows; direct read stays blocked', async () => {
  const vendorA = await seedVendor(`!CRH04-A-${T}`);
  const vendorB = await seedVendor(`!CRH04-B-${T}`);
  const phone = nextPhone('88084');
  const device = trackDevice(`devCRH04_${T}`);

  // One row saved under the phone, one older row still under the device only.
  await supabaseAdmin.from('saved_vendors').insert([
    { vendor_id: vendorA, user_phone: phone, device_id: `devCRH04_oldphone_${T}`, category: 'Pharmacy' },
    { vendor_id: vendorB, user_phone: null, device_id: device, category: 'Pharmacy' },
  ]);

  const direct = await supabase.from('saved_vendors').select('id').eq('user_phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_saved_vendors_count', {
    p_user_phone: phone,
    p_device_id: device,
  });
  expect(error, error?.message).toBeNull();
  expect(data).toBe(2); // OR semantics: phone row + unmigrated device row

  await supabaseAdmin.from('saved_vendors').delete().in('vendor_id', [vendorA, vendorB]);
});

test('CRH-05 — get_my_feed_flags returns own flags only; direct read stays blocked', async () => {
  const phone = nextPhone('88085');
  const otherPhone = nextPhone('88086');

  const { data: post, error: postErr } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      user_phone: otherPhone,
      type: 'announcement',
      content: `customer-read-hardening-${T}`,
      target_audience: 'customers',
    })
    .select('id')
    .single();
  expect(postErr, postErr?.message).toBeNull();
  createdPostIds.push(post!.id);

  await supabaseAdmin.from('feed_flags').insert({ post_id: post!.id, flagged_by_phone: phone });

  const direct = await supabase.from('feed_flags').select('post_id').eq('flagged_by_phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_my_feed_flags', {
    p_user_phone: phone,
    p_post_ids: [post!.id],
  });
  expect(error, error?.message).toBeNull();
  expect((data ?? []).map((r: { post_id: string }) => r.post_id)).toEqual([post!.id]);

  // Someone else's phone sees no flags for the same posts.
  const { data: other } = await supabase.rpc('get_my_feed_flags', {
    p_user_phone: otherPhone,
    p_post_ids: [post!.id],
  });
  expect(other ?? []).toEqual([]);
});

test('CRH-06 — get_my_addresses scopes device OR phone; direct read cannot see other people\'s rows', async () => {
  const phone = nextPhone('88087');
  const otherPhone = nextPhone('88088');
  const device = trackDevice(`devCRH06_${T}`);

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('user_addresses')
    .insert([
      { user_phone: phone, device_id: `devCRH06_old_${T}`, label: 'Home', address_text: `Addr mine ${T}`, is_default: true },
      { user_phone: null, device_id: device, label: 'Work', address_text: `Addr device ${T}`, is_default: false },
      { user_phone: otherPhone, device_id: `devCRH06_other_${T}`, label: 'Other', address_text: `Addr foreign ${T}`, is_default: false },
    ])
    .select('id');
  expect(insertErr, insertErr?.message).toBeNull();
  for (const row of inserted ?? []) createdAddressIds.push(row.id);

  // The world-read hole is closed: an anon caller reading someone's phone-linked
  // addresses directly gets nothing (old PROD policy allowed user_phone IS NOT NULL).
  const direct = await supabase.from('user_addresses').select('id').eq('user_phone', otherPhone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_my_addresses', {
    p_user_phone: phone,
    p_device_id: device,
  });
  expect(error, error?.message).toBeNull();
  const labels = ((data ?? []) as Array<{ label: string }>).map((r) => r.label).sort();
  expect(labels).toEqual(['Home', 'Work']); // own phone row + own device row, not the foreign one
});

test('CRH-07 — should_notify_vendor_order_edit: dedups within 2 min, rejects non-owners', async () => {
  const vendorId = await seedVendor(`!CRH07-${T}`);
  const { data: vendorRow } = await supabaseAdmin
    .from('vendors')
    .select('phone')
    .eq('id', vendorId)
    .single();
  const vendorPhone = vendorRow!.phone as string;
  const phone = nextPhone('88089');
  const device = trackDevice(`devCRH07_${T}`);
  const reqId = await seedRequest(vendorId, phone, device, { status: 'accepted' });

  // No recent notification → should notify.
  const { data: first, error: firstErr } = await supabase.rpc('should_notify_vendor_order_edit', {
    p_request_id: reqId,
    p_user_phone: phone,
    p_device_id: device,
  });
  expect(firstErr, firstErr?.message).toBeNull();
  expect(first).toBe(true);

  // Vendor got an order_update notification 1 min ago → dedup fires.
  await supabaseAdmin.from('user_notifications').insert({
    user_phone: vendorPhone,
    type: 'order_update',
    title: 'test',
    body: `customer-read-hardening-${T}`,
    related_id: reqId,
  });
  const { data: second, error: secondErr } = await supabase.rpc('should_notify_vendor_order_edit', {
    p_request_id: reqId,
    p_user_phone: phone,
    p_device_id: device,
  });
  expect(secondErr, secondErr?.message).toBeNull();
  expect(second).toBe(false);

  // A stranger who doesn't own the request is rejected outright.
  const { error: strangerErr } = await supabase.rpc('should_notify_vendor_order_edit', {
    p_request_id: reqId,
    p_user_phone: nextPhone('88090'),
    p_device_id: trackDevice(`devCRH07_stranger_${T}`),
  });
  expect(strangerErr?.message ?? '').toContain('not_found_or_unauthorized');
});

test('CRH-08 — fetchUserTrust path: lookup_user_by_phone returns trust/ban for no-session caller; direct users read stays blocked', async () => {
  const phone = nextPhone('88091');
  await supabaseAdmin
    .from('users')
    .upsert({ phone, trust_score: 20, is_banned: true }, { onConflict: 'phone' });

  const direct = await supabase.from('users').select('phone').eq('phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('lookup_user_by_phone', { p_phone: phone });
  expect(error, error?.message).toBeNull();
  const row = (data ?? [])[0] as { trust_score: number; is_banned: boolean } | undefined;
  expect(row).toBeTruthy();
  expect(row!.is_banned).toBe(true);
  expect(row!.trust_score).toBe(20);
});

test('CRH-09 — rate limit fires on the new read RPCs', async () => {
  const device = trackDevice(`devCRH09_${T}`);
  // get_my_addresses: 30/60 per identity.
  let limited = false;
  for (let i = 0; i < 32; i++) {
    const { error } = await supabase.rpc('get_my_addresses', {
      p_user_phone: null,
      p_device_id: device,
    });
    if (error?.message?.includes('rate_limited')) {
      limited = true;
      break;
    }
  }
  expect(limited).toBe(true);
});
