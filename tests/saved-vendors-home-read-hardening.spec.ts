import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

// Read-path hardening for Home saved-neighbours + removal notices (OTP-off identity).
// `supabase` here is the anon-key client with NO Supabase Auth session — exactly how
// OTP-off production callers reach the DB. `supabaseAdmin` (service role) is seed/cleanup only.

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const rlIdentifiers: string[] = [];
const RL_ACTIONS = ['save_saved_vendor', 'unsave_saved_vendor', 'migrate_saved_vendors_phone'];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(shopName: string, category: { id: string; label: string; service_mode: string }) {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Home Read Owner',
      shop_name: shopName,
      phone: nextPhone('99071'),
      category: category.label,
      service_mode: category.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, category, { is_primary: true });
  return data.id as string;
}

test.afterAll(async () => {
  for (const phone of createdPhones) {
    await supabaseAdmin.from('saved_vendor_removal_notices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
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

test('HR-01 — get_saved_vendors returns only the caller\'s rows for a no-session phone caller; direct table read stays blocked', async () => {
  const cat = await getActiveCategoryByLabel('Electrician');
  const vendorId = await seedVendor(`!HR-A-${T}`, cat);
  const phoneA = nextPhone('88071');
  const phoneB = nextPhone('88072');
  await supabaseAdmin
    .from('users')
    .upsert([{ phone: phoneA, trust_score: 75 }, { phone: phoneB, trust_score: 75 }], { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendors').insert([
    { user_phone: phoneA, device_id: `devA_${T}`, vendor_id: vendorId, category: cat.label, nickname: 'A save' },
    { user_phone: phoneB, device_id: `devB_${T}`, vendor_id: vendorId, category: cat.label, nickname: 'B save' },
  ]);

  // Direct anon table read is still blocked by restrictive RLS (owner policy, no session) — not reopened.
  const direct = await supabase.from('saved_vendors').select('id').eq('user_phone', phoneA);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  // RPC (caller-supplied phone, no session) returns exactly A's rows.
  const { data, error } = await supabase.rpc('get_saved_vendors', {
    p_user_phone: phoneA,
    p_device_id: `devA_${T}`,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{ user_phone: string; vendor_id: string }>;
  expect(rows.length).toBe(1);
  expect(rows.every((r) => r.user_phone === phoneA)).toBe(true);
  expect(rows.some((r) => r.user_phone === phoneB)).toBe(false);

  // A different caller only sees their own row, never A's.
  const { data: dataB } = await supabase.rpc('get_saved_vendors', {
    p_user_phone: phoneB,
    p_device_id: `devB_${T}`,
  });
  const rowsB = (dataB ?? []) as Array<{ user_phone: string }>;
  expect(rowsB.length).toBe(1);
  expect(rowsB.every((r) => r.user_phone === phoneB)).toBe(true);
});

test('HR-02 — removal notices are not readable via direct anon table access, but are readable via the scoped RPC', async () => {
  const phoneC = nextPhone('88073');
  await supabaseAdmin.from('users').upsert({ phone: phoneC, trust_score: 75 }, { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendor_removal_notices').insert({
    user_phone: phoneC,
    shop_name: 'Gamma Store',
    category_label: 'Plumber',
    reason: 'category_removed',
  });

  // Direct anon reads (filtered + unfiltered) now return nothing — the USING(true) policy is gone.
  const direct = await supabase
    .from('saved_vendor_removal_notices')
    .select('id, user_phone, shop_name')
    .eq('user_phone', phoneC);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const all = await supabase.from('saved_vendor_removal_notices').select('id, user_phone');
  expect(all.error).toBeNull();
  expect(all.data).toEqual([]);

  // Scoped RPC returns the caller's own notice.
  const { data, error } = await supabase.rpc('get_saved_vendor_removal_notices', {
    p_user_phone: phoneC,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{ user_phone: string; shop_name: string; reason: string }>;
  expect(rows.length).toBe(1);
  expect(rows[0].user_phone).toBe(phoneC);
  expect(rows[0].shop_name).toBe('Gamma Store');
  expect(rows[0].reason).toBe('category_removed');
});

test('HR-03 — account anonymisation clears the customer\'s removal notices (no orphan PII)', async () => {
  const phoneD = nextPhone('88074');
  const now = new Date().toISOString();
  await supabaseAdmin
    .from('users')
    .upsert({ phone: phoneD, trust_score: 75, deletion_requested_at: now }, { onConflict: 'phone' });
  await supabaseAdmin.from('saved_vendor_removal_notices').insert({
    user_phone: phoneD,
    shop_name: 'Delta Depot',
    category_label: null,
    reason: 'account_deleted',
  });

  // Sanity: notice exists before anonymisation.
  const before = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .select('id')
    .eq('user_phone', phoneD);
  expect(before.data?.length).toBe(1);

  const { error: anonErr } = await supabaseAdmin.rpc('anonymise_deleted_accounts');
  expect(anonErr, anonErr?.message).toBeNull();

  const after = await supabaseAdmin
    .from('saved_vendor_removal_notices')
    .select('id')
    .eq('user_phone', phoneD);
  expect(after.data).toEqual([]);
});

test('HR-04 — save/unsave/migrate saved-vendor RPCs are rate limited (30 / 60s per identifier)', async () => {
  const cat = await getActiveCategoryByLabel('Electrician');
  const vendorId = await seedVendor(`!HR-RL-${T}`, cat);

  // save_saved_vendor — bucketed by phone. saved_vendors has unique(user_phone,vendor_id)
  // and unique(device_id,vendor_id), so use 31 distinct vendors to stay in one phone bucket
  // without tripping either uniqueness constraint.
  const saveVendorRows = Array.from({ length: 31 }, (_, i) => ({
    name: 'HR RL Owner',
    shop_name: `!HR-RLV-${T}-${i}`,
    phone: nextPhone('99072'),
    category: cat.label,
    service_mode: cat.service_mode,
    latitude: 18.5204,
    longitude: 73.8567,
    is_active: true,
    profile_status: 'complete',
    service_radius_km: 9999,
  }));
  const { data: saveVendors, error: svErr } = await supabaseAdmin
    .from('vendors')
    .insert(saveVendorRows)
    .select('id');
  if (svErr) throw svErr;
  for (const row of saveVendors ?? []) createdVendorIds.push(row.id);

  const savePhone = nextPhone('88075');
  rlIdentifiers.push(savePhone);
  const saveErrors: (string | null)[] = [];
  for (let i = 0; i < 31; i++) {
    const { error } = await supabase.rpc('save_saved_vendor', {
      p_vendor_id: saveVendors![i].id,
      p_category: cat.label,
      p_nickname: 'RL save',
      p_device_id: `dev_${savePhone}_${i}`,
      p_user_phone: savePhone,
    });
    saveErrors.push(error?.message ?? null);
  }
  expect(saveErrors.slice(0, 30).every((e) => e === null)).toBe(true);
  expect(saveErrors[30]).toContain('rate_limited');

  // unsave_saved_vendor — bucketed by phone.
  const unsavePhone = nextPhone('88076');
  rlIdentifiers.push(unsavePhone);
  const unsaveErrors: (string | null)[] = [];
  for (let i = 0; i < 31; i++) {
    const { error } = await supabase.rpc('unsave_saved_vendor', {
      p_vendor_id: vendorId,
      p_device_id: `dev_unsave_${unsavePhone}`,
      p_user_phone: unsavePhone,
    });
    unsaveErrors.push(error?.message ?? null);
  }
  expect(unsaveErrors.slice(0, 30).every((e) => e === null)).toBe(true);
  expect(unsaveErrors[30]).toContain('rate_limited');

  // migrate_saved_vendors_phone — bucketed by device_id.
  const migPhone = nextPhone('88077');
  const migDevice = `dev_mig_${T}`;
  rlIdentifiers.push(migDevice);
  const migErrors: (string | null)[] = [];
  for (let i = 0; i < 31; i++) {
    const { error } = await supabase.rpc('migrate_saved_vendors_phone', {
      p_device_id: migDevice,
      p_user_phone: migPhone,
    });
    migErrors.push(error?.message ?? null);
  }
  expect(migErrors.slice(0, 30).every((e) => e === null)).toBe(true);
  expect(migErrors[30]).toContain('rate_limited');
});
