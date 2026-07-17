/**
 * Settings hardening: delete-account device binding, subscription field gate, owner name persist.
 */
import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';
import { postDeleteAccount, uniqueTestPhone } from './helpers/session38';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '880' | '990'): string {
  phoneSeq += 1;
  const phone = `${prefix}75${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(phone: string, shop: string) {
  const category = await getActiveCategoryByLabel('Grocery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: 'Old Name',
      shop_name: `!SET-${shop}-${T}`,
      category: category.label,
      service_mode: category.service_mode,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 5,
      discoverable: true,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      subscription_status: 'trial',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);
  return vendor.id as string;
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('user_addresses').delete().eq('user_phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
    await supabaseAdmin.from('vendors').delete().eq('phone', phone);
  }
});

test('SET-SEC-01 — delete-account rejects bare phone-only request (no device_id)', async () => {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });

  const { status, body } = await postDeleteAccount({ phone, type: 'customer' });
  expect(status).toBe(400);
  expect(body.error).toBe('device_id_required');

  const { data: user } = await supabaseAdmin
    .from('users')
    .select('deletion_requested_at')
    .eq('phone', phone)
    .maybeSingle();
  expect(user?.deletion_requested_at).toBeNull();
});

test('SET-SEC-02 — delete-account rejects phone with unrelated device_id', async () => {
  const phone = nextPhone('880');
  const deviceId = `device_ok_${TEST_SESSION}_${phone}`;
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: deviceId,
    fcm_token: `fcm_${phone}`,
  });

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: `device_wrong_${TEST_SESSION}`,
  });
  expect(status).toBe(403);
  expect(body.error).toBe('device_not_associated');
});

test('SET-SEC-03 — delete-account succeeds when device_id is associated with phone', async () => {
  const phone = nextPhone('880');
  const deviceId = `device_ok_${TEST_SESSION}_${phone}`;
  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: null },
    { onConflict: 'phone' },
  );
  await supabaseAdmin.from('user_devices').insert({
    user_phone: phone,
    device_id: deviceId,
    fcm_token: `fcm_${phone}`,
  });

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: deviceId,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
});

test('SET-SEC-04 — vendor_update_own rejects subscription_status / subscription_id / grace_ends_at', async () => {
  const phone = nextPhone('990');
  const vendorId = await seedVendor(phone, 'SubGate');

  for (const patch of [
    { subscription_status: 'active' },
    { subscription_id: 'sub_fake_123' },
    { grace_ends_at: new Date().toISOString() },
  ]) {
    const { error } = await supabaseAdmin.rpc('vendor_update_own', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_patch: patch,
    });
    expect(error?.message, JSON.stringify(patch)).toContain('field_not_allowed');
  }

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('subscription_status, subscription_id, grace_ends_at')
    .eq('id', vendorId)
    .single();
  expect(data?.subscription_status).toBe('trial');
  expect(data?.subscription_id ?? null).toBeNull();
  expect(data?.grace_ends_at ?? null).toBeNull();
});

test('SET-SEC-05 — vendor_update_own persists owner name', async () => {
  const phone = nextPhone('990');
  const vendorId = await seedVendor(phone, 'NamePersist');

  const { error } = await supabaseAdmin.rpc('vendor_update_own', {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_patch: { name: 'New Owner Name' },
  });
  expect(error, error?.message).toBeNull();

  const { data } = await supabaseAdmin
    .from('vendors')
    .select('name')
    .eq('id', vendorId)
    .single();
  expect(data?.name).toBe('New Owner Name');
});

test('SET-SEC-06 — web-like customer (no FCM) can delete after ensure_user_device_link', async () => {
  const phone = nextPhone('880');
  const deviceId = `device_web_${TEST_SESSION}_${phone}`;

  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: null },
    { onConflict: 'phone' },
  );

  // Simulate phone-save association without push token (web / denied notifications).
  const { error: linkError } = await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phone,
    p_device_id: deviceId,
  });
  expect(linkError, linkError?.message).toBeNull();

  const { data: deviceRow } = await supabaseAdmin
    .from('user_devices')
    .select('fcm_token, device_id')
    .eq('user_phone', phone)
    .eq('device_id', deviceId)
    .maybeSingle();
  expect(deviceRow?.device_id).toBe(deviceId);
  expect(deviceRow?.fcm_token ?? null).toBeNull();

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: deviceId,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
  expect(body.error).not.toBe('device_not_associated');
});

test('SET-SEC-07 — delete succeeds via address history when no user_devices row exists', async () => {
  const phone = nextPhone('880');
  const deviceId = `device_addr_${TEST_SESSION}_${phone}`;

  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: null },
    { onConflict: 'phone' },
  );
  // Explicitly no user_devices / app_users — only prior address usage on this device.
  await supabaseAdmin.from('user_addresses').insert({
    user_phone: phone,
    device_id: deviceId,
    label: 'Home',
    address_text: 'Web usage address',
    is_default: true,
  });

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: deviceId,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
});

test('SET-SEC-08 — delete succeeds via request history when no user_devices row exists', async () => {
  const phone = nextPhone('880');
  const deviceId = `device_req_${TEST_SESSION}_${phone}`;
  const vendorId = await seedVendor(nextPhone('990'), 'ReqHist');

  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: null },
    { onConflict: 'phone' },
  );
  await supabaseAdmin.from('requests').insert({
    vendor_id: vendorId,
    device_id: deviceId,
    user_phone: phone,
    message: 'prior usage',
    status: 'sent',
  });

  const { status, body } = await postDeleteAccount({
    phone,
    type: 'customer',
    device_id: deviceId,
  });
  expect(status).toBe(200);
  expect(body.ok).toBe(true);
});
