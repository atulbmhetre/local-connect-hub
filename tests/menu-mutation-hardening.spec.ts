import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

// Menu mutation hardening (20260719000001):
//   - all four vendor menu mutation RPCs are rate-limited 30/min per phone
//   - identity is still asserted before the rate limit (wrong phone never
//     consumes budget and still fails with not_found_or_unauthorized)
//
// Rate-limit state is pre-seeded directly into edge_function_rate_limits via
// the service role instead of making 30 live calls per RPC — this tests the
// same code path (check_and_log_rate_limit reads the table) while keeping the
// suite fast.

const T = Date.now();
const RATE_LIMIT_MAX = 30;

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

function nextPhone(): string {
  const phone = `99041${String(T + createdPhones.length).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function createMenuVendor() {
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = nextPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Menu RL Owner',
      shop_name: `!MENU-RL-${T}-${createdVendorIds.length}`,
      phone,
      category: plumber.label,
      service_mode: plumber.service_mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, plumber, { is_primary: true });
  return { vendorId: vendor.id, phone, categoryId: plumber.id };
}

/** Pre-seed the phone's bucket to the limit so the next call is blocked. */
async function exhaustRateLimit(functionName: string, phone: string) {
  const rows = Array.from({ length: RATE_LIMIT_MAX }, () => ({
    function_name: functionName,
    identifier_type: 'phone',
    identifier: phone,
  }));
  const { error } = await supabaseAdmin.from('edge_function_rate_limits').insert(rows);
  if (error) throw error;
}

async function clearRateLimit(functionName: string, phone: string) {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', functionName)
    .eq('identifier', phone);
}

async function insertOneItem(vendorId: string, phone: string, name: string) {
  return supabase.rpc('vendor_insert_menu_items', {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_items: [{ name, price: 10, sort_order: 0 }],
  });
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_menu_items').delete().eq('vendor_id', id);
    const { data: vcRows } = await supabaseAdmin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', id);
    const vcIds = (vcRows ?? []).map((r) => r.id);
    if (vcIds.length) {
      await supabaseAdmin.from('vendor_category_modes').delete().in('vendor_category_id', vcIds);
    }
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin
      .from('edge_function_rate_limits')
      .delete()
      .eq('identifier', phone);
  }
});

test('MRL-01: menu insert under the rate limit succeeds', async () => {
  const { vendorId, phone } = await createMenuVendor();
  const { error } = await insertOneItem(vendorId, phone, 'Under limit item');
  expect(error, error?.message).toBeNull();

  const { data: items } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('name')
    .eq('vendor_id', vendorId);
  expect(items?.map((i) => i.name)).toContain('Under limit item');
});

test('MRL-02: vendor_insert_menu_items is blocked at the phone rate limit', async () => {
  const { vendorId, phone } = await createMenuVendor();
  await exhaustRateLimit('vendor_insert_menu_items', phone);
  try {
    const { error } = await insertOneItem(vendorId, phone, 'Blocked item');
    expect(error?.message ?? '').toMatch(/rate_limited/);

    const { data: items } = await supabaseAdmin
      .from('vendor_menu_items')
      .select('name')
      .eq('vendor_id', vendorId)
      .eq('name', 'Blocked item');
    expect(items ?? []).toHaveLength(0);
  } finally {
    await clearRateLimit('vendor_insert_menu_items', phone);
  }
});

test('MRL-03: vendor_update_menu_item is blocked at the phone rate limit', async () => {
  const { vendorId, phone } = await createMenuVendor();
  const { error: insErr } = await insertOneItem(vendorId, phone, 'Update target');
  expect(insErr, insErr?.message).toBeNull();
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', vendorId)
    .eq('name', 'Update target')
    .single();

  await exhaustRateLimit('vendor_update_menu_item', phone);
  try {
    const { error } = await supabase.rpc('vendor_update_menu_item', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_item_id: item!.id,
      p_name: 'Should not apply',
      p_price: 999,
      p_unit: null,
      p_description: null,
    });
    expect(error?.message ?? '').toMatch(/rate_limited/);

    const { data: after } = await supabaseAdmin
      .from('vendor_menu_items')
      .select('name, price')
      .eq('id', item!.id)
      .single();
    expect(after?.name).toBe('Update target');
  } finally {
    await clearRateLimit('vendor_update_menu_item', phone);
  }

  // After clearing the bucket the same update goes through.
  const { error: okErr } = await supabase.rpc('vendor_update_menu_item', {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_item_id: item!.id,
    p_name: 'Applied after clear',
    p_price: 55,
    p_unit: null,
    p_description: null,
  });
  expect(okErr, okErr?.message).toBeNull();
});

test('MRL-04: vendor_toggle_menu_item_availability is blocked at the phone rate limit', async () => {
  const { vendorId, phone } = await createMenuVendor();
  const { error: insErr } = await insertOneItem(vendorId, phone, 'Toggle target');
  expect(insErr, insErr?.message).toBeNull();
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id, is_available')
    .eq('vendor_id', vendorId)
    .eq('name', 'Toggle target')
    .single();

  await exhaustRateLimit('vendor_toggle_menu_item_availability', phone);
  try {
    const { error } = await supabase.rpc('vendor_toggle_menu_item_availability', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_item_id: item!.id,
    });
    expect(error?.message ?? '').toMatch(/rate_limited/);

    const { data: after } = await supabaseAdmin
      .from('vendor_menu_items')
      .select('is_available')
      .eq('id', item!.id)
      .single();
    expect(after?.is_available).toBe(item!.is_available);
  } finally {
    await clearRateLimit('vendor_toggle_menu_item_availability', phone);
  }
});

test('MRL-05: vendor_delete_menu_item is blocked at the phone rate limit', async () => {
  const { vendorId, phone } = await createMenuVendor();
  const { error: insErr } = await insertOneItem(vendorId, phone, 'Delete target');
  expect(insErr, insErr?.message).toBeNull();
  const { data: item } = await supabaseAdmin
    .from('vendor_menu_items')
    .select('id')
    .eq('vendor_id', vendorId)
    .eq('name', 'Delete target')
    .single();

  await exhaustRateLimit('vendor_delete_menu_item', phone);
  try {
    const { error } = await supabase.rpc('vendor_delete_menu_item', {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_item_id: item!.id,
    });
    expect(error?.message ?? '').toMatch(/rate_limited/);

    const { data: after } = await supabaseAdmin
      .from('vendor_menu_items')
      .select('id')
      .eq('id', item!.id);
    expect(after ?? []).toHaveLength(1);
  } finally {
    await clearRateLimit('vendor_delete_menu_item', phone);
  }
});

test('MRL-06: wrong phone still rejected before rate limiting (identity first)', async () => {
  const { vendorId } = await createMenuVendor();
  const wrongPhone = '9900099000';

  const { error } = await insertOneItem(vendorId, wrongPhone, 'Should never exist');
  expect(error?.message ?? '').toMatch(/not_found_or_unauthorized/);

  // Identity failure must not consume rate-limit budget for that phone.
  const { data: rows } = await supabaseAdmin
    .from('edge_function_rate_limits')
    .select('id')
    .eq('function_name', 'vendor_insert_menu_items')
    .eq('identifier', wrongPhone);
  expect(rows ?? []).toHaveLength(0);
});
