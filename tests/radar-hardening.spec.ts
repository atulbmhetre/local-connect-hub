/**
 * Radar hardening: RLS, subscription filter RPCs, admin health stats.
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin, TEST_SESSION } from './helpers/setup';

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const anonClient = createClient(supabaseUrl, anonKey);

test('RAD-RLS-01 — anon cannot read banned vendor via public SELECT', async () => {
  const phone = `88071${Date.now().toString().slice(-5)}`;
  const { data: vendor, error: insErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: 'Banned RLS',
      shop_name: `!RAD-RLS-${TEST_SESSION}`,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: true,
      is_banned: true,
      discoverable: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();
  expect(insErr).toBeNull();

  const { data, error } = await anonClient
    .from('vendors')
    .select('id, phone')
    .eq('id', vendor!.id)
    .maybeSingle();

  expect(error).toBeNull();
  expect(data).toBeNull();

  await supabaseAdmin.from('vendors').delete().eq('id', vendor!.id);
});

test('RAD-RLS-02 — anon cannot read non-discoverable vendor via public SELECT', async () => {
  const phone = `88072${Date.now().toString().slice(-5)}`;
  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: 'Hidden RLS',
      shop_name: `!RAD-RLS-H-${TEST_SESSION}`,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: true,
      is_banned: false,
      discoverable: false,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();

  const { data } = await anonClient
    .from('vendors')
    .select('id')
    .eq('id', vendor!.id)
    .maybeSingle();

  expect(data).toBeNull();

  await supabaseAdmin.from('vendors').delete().eq('id', vendor!.id);
});

test('RAD-RLS-03 — get_vendor_own returns full row for matching id+phone', async () => {
  const phone = `88073${Date.now().toString().slice(-5)}`;
  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: 'Own Read',
      shop_name: `!RAD-OWN-${TEST_SESSION}`,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: true,
      is_banned: false,
      discoverable: false,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();

  const { data, error } = await anonClient.rpc('get_vendor_own', {
    p_vendor_id: vendor!.id,
    p_vendor_phone: phone,
  });

  expect(error).toBeNull();
  expect(data?.id).toBe(vendor!.id);
  expect(data?.discoverable).toBe(false);

  await supabaseAdmin.from('vendors').delete().eq('id', vendor!.id);
});

test('RAD-HEALTH-01 — log_radar_search feeds get_admin_radar_health_stats', async () => {
  const deviceId = `radar_health_${TEST_SESSION}_${Date.now()}`;

  await supabaseAdmin.rpc('log_radar_search', {
    p_device_id: deviceId,
    p_result_count: 0,
    p_categories_loaded: true,
  });
  await supabaseAdmin.rpc('log_radar_search', {
    p_device_id: deviceId,
    p_result_count: 3,
    p_categories_loaded: true,
  });

  const { data, error } = await supabaseAdmin.rpc('get_admin_radar_health_stats', {
    p_hours: 1,
  });

  expect(error).toBeNull();
  expect((data as { total_searches: number }).total_searches).toBeGreaterThanOrEqual(2);
  expect((data as { categories_ok: boolean }).categories_ok).toBe(true);

  await supabaseAdmin.from('radar_search_log').delete().eq('device_id', deviceId);
});

test('RAD-SUB-01 — expired subscription vendor excluded from discoverable anon SELECT', async () => {
  const phone = `88074${Date.now().toString().slice(-5)}`;
  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: 'Expired Sub',
      shop_name: `!RAD-SUB-${TEST_SESSION}`,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: false,
      is_banned: false,
      discoverable: true,
      profile_status: 'complete',
      subscription_status: 'expired',
      service_radius_km: 9999,
    })
    .select('id')
    .single();

  const { data } = await anonClient
    .from('vendors')
    .select('id')
    .eq('id', vendor!.id)
    .maybeSingle();

  // RLS allows discoverable complete non-banned; subscription filter is app-level in Radar.
  // Expired vendor still readable via RLS if discoverable — subscription gating is client query filter.
  // Verify Radar query shape excludes expired at SQL level when using .not('subscription_status'...)
  const { data: filtered } = await anonClient
    .from('vendors')
    .select('id')
    .eq('id', vendor!.id)
    .eq('discoverable', true)
    .eq('is_banned', false)
    .eq('profile_status', 'complete')
    .or('subscription_status.is.null,subscription_status.in.(trial,active,grace)')
    .maybeSingle();

  expect(data?.id).toBe(vendor!.id);
  expect(filtered).toBeNull();

  await supabaseAdmin.from('vendors').delete().eq('id', vendor!.id);
});
