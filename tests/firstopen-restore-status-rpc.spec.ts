import { test, expect } from '@playwright/test';
import { supabaseAdmin, TEST_SESSION, getActiveCategoryByServiceMode, seedVendorCategory } from './helpers/setup';

const T = Date.now();
let phoneSeq = 0;
const createdPhones: string[] = [];
const createdVendorIds: string[] = [];
const createdDeviceIds: string[] = [];

function nextPhone(prefix: string): string {
  phoneSeq += 1;
  return `${prefix}${String(T + phoneSeq).slice(-5)}`;
}

async function createVendor(phone: string, overrides: Record<string, unknown> = {}) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Restore RPC ${phone}`,
      shop_name: `!RPC-${phone}`,
      phone,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.52,
      longitude: 73.85,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 5,
      ...overrides,
    })
    .select('id')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor!.id, category);
  createdVendorIds.push(vendor!.id);
  createdPhones.push(phone);
  return vendor!.id as string;
}

test.afterAll(async () => {
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  if (createdPhones.length || createdDeviceIds.length) {
    const identifiers = [...new Set([...createdPhones, ...createdDeviceIds])];
    await supabaseAdmin
      .from('edge_function_rate_limits')
      .delete()
      .in('function_name', [
        'get_vendor_restore_status',
        'lookup_user_by_phone',
        'migrate_device_requests_phone',
        'ensure_user_device_link',
      ])
      .in('identifier', identifiers);
  }
});

test('RESTORE-RPC-01 — active vendor restore allowed', async () => {
  const phone = nextPhone('88110');
  const vendorId = await createVendor(phone, { discoverable: true, is_active: true });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.found).toBe(true);
  expect(data.vendor_id).toBe(vendorId);
  expect(data.restore_allowed).toBe(true);
  expect(data.deny_reason).toBeNull();
});

test('RESTORE-RPC-02 — offline vendor is restorable (is_active=false)', async () => {
  const phone = nextPhone('88111');
  const vendorId = await createVendor(phone, { is_active: false, discoverable: true });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.vendor_id).toBe(vendorId);
  expect(data.is_active).toBe(false);
  expect(data.restore_allowed).toBe(true);
});

test('RESTORE-RPC-03 — hidden vendor is restorable (discoverable=false)', async () => {
  const phone = nextPhone('88112');
  const vendorId = await createVendor(phone, { discoverable: false, is_active: true });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.vendor_id).toBe(vendorId);
  expect(data.discoverable).toBe(false);
  expect(data.restore_allowed).toBe(true);
});

test('RESTORE-RPC-04 — banned vendor restore denied', async () => {
  const phone = nextPhone('88113');
  await createVendor(phone, { is_banned: true, is_active: true });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.found).toBe(true);
  expect(data.is_banned).toBe(true);
  expect(data.is_active).toBe(false); // trigger forces offline
  expect(data.restore_allowed).toBe(false);
  expect(data.deny_reason).toBe('banned');
});

test('RESTORE-RPC-05 — deletion_requested vendor restore denied', async () => {
  const phone = nextPhone('88114');
  await createVendor(phone, { deletion_requested_at: new Date().toISOString() });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.restore_allowed).toBe(false);
  expect(data.deny_reason).toBe('deleted');
});

test('RESTORE-RPC-06 — draft/incomplete profile is restorable', async () => {
  const phone = nextPhone('88115');
  await createVendor(phone, { profile_status: 'draft', discoverable: false });

  const { data, error } = await supabaseAdmin.rpc('get_vendor_restore_status', {
    p_phone: phone,
  });
  expect(error, error?.message).toBeNull();
  expect(data.restore_allowed).toBe(true);
  expect(data.profile_status).toBe('draft');
});

test('RESTORE-RPC-07 — lookup_user_by_phone is phone rate-limited', async () => {
  const phone = nextPhone('88116');
  const { error: upsertErr } = await supabaseAdmin.from('users').upsert(
    { phone, total_orders: 1, trust_score: 70 },
    { onConflict: 'phone' },
  );
  expect(upsertErr, upsertErr?.message).toBeNull();
  createdPhones.push(phone);

  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', 'lookup_user_by_phone')
    .eq('identifier', phone);

  for (let i = 0; i < 10; i++) {
    const { error } = await supabaseAdmin.rpc('lookup_user_by_phone', { p_phone: phone });
    expect(error, error?.message).toBeNull();
  }

  const blocked = await supabaseAdmin.rpc('lookup_user_by_phone', { p_phone: phone });
  expect(blocked.error?.message ?? '').toMatch(/rate_limit/i);
});

test('RESTORE-RPC-07b — migrate_device_requests_phone is device rate-limited', async () => {
  const deviceId = `dev_mig_req_${T}`;
  createdDeviceIds.push(deviceId);
  const phone = nextPhone('88118');
  createdPhones.push(phone);

  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', 'migrate_device_requests_phone')
    .eq('identifier', deviceId);

  for (let i = 0; i < 30; i++) {
    const { error } = await supabaseAdmin.rpc('migrate_device_requests_phone', {
      p_device_id: deviceId,
      p_user_phone: phone,
    });
    expect(error, error?.message).toBeNull();
  }

  const blocked = await supabaseAdmin.rpc('migrate_device_requests_phone', {
    p_device_id: deviceId,
    p_user_phone: phone,
  });
  expect(blocked.error?.message ?? '').toMatch(/rate_limit/i);
});

test('RESTORE-RPC-07c — ensure_user_device_link is device rate-limited', async () => {
  const deviceId = `dev_ensure_${T}`;
  createdDeviceIds.push(deviceId);
  const phone = nextPhone('88119');
  createdPhones.push(phone);

  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', 'ensure_user_device_link')
    .eq('identifier', deviceId);

  for (let i = 0; i < 30; i++) {
    const { error } = await supabaseAdmin.rpc('ensure_user_device_link', {
      p_user_phone: phone,
      p_device_id: deviceId,
    });
    expect(error, error?.message).toBeNull();
  }

  const blocked = await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phone,
    p_device_id: deviceId,
  });
  expect(blocked.error?.message ?? '').toMatch(/rate_limit/i);

  await supabaseAdmin.from('user_devices').delete().eq('device_id', deviceId);
});

test('RESTORE-RPC-08 — banned vendor cannot accept orders', async () => {
  const phone = nextPhone('88117');
  const vendorId = await createVendor(phone, { is_banned: true });

  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      status: 'sent',
      message: `ban-gate-${TEST_SESSION}`,
      user_phone: nextPhone('88200'),
      device_id: `dev_${TEST_SESSION}_ban`,
    })
    .select('id')
    .single();
  expect(reqErr, reqErr?.message).toBeNull();

  const { error } = await supabaseAdmin.rpc('vendor_accept_order', {
    p_request_id: req!.id,
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_from_status: 'sent',
  });
  expect(error?.message ?? '').toMatch(/vendor_banned/i);

  await supabaseAdmin.from('requests').delete().eq('id', req!.id);
});

test('RESTORE-RPC-09 — log + admin restore health stats', async () => {
  const deviceId = `restore_health_${TEST_SESSION}`;
  await supabaseAdmin.rpc('log_firstopen_restore', {
    p_outcome: 'success_vendor_offline',
    p_device_id: deviceId,
  });
  await supabaseAdmin.rpc('log_firstopen_restore', {
    p_outcome: 'denied_banned',
    p_device_id: deviceId,
  });

  const { data, error } = await supabaseAdmin.rpc('get_admin_restore_health_stats', {
    p_hours: 24,
  });
  expect(error, error?.message).toBeNull();
  expect(Number(data.attempts)).toBeGreaterThanOrEqual(2);
  expect(Number(data.offline_now_restorable)).toBeGreaterThanOrEqual(1);
  expect(Number(data.denied_banned)).toBeGreaterThanOrEqual(1);
});
