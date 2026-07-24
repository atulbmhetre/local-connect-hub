import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin, getActiveCategoryByLabel, seedVendorCategory } from './helpers/setup';

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(shopName: string) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const phone = nextPhone('99095');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Khata Limits Vendor',
      shop_name: shopName,
      phone,
      category: cat.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: 'complete',
      service_radius_km: 15,
      khata_amber_limit: 0,
      khata_red_limit: 0,
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return data as { id: string; phone: string };
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('KHATA-LIM-01 — vendor_update_own rejects red <= amber (khata_limits_invalid)', async () => {
  const vendor = await seedVendor(`!KHLIM01-${T}`);

  const { error: bad } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { khata_amber_limit: 500, khata_red_limit: 400 },
  });
  expect(bad?.message ?? '').toContain('khata_limits_invalid');

  const { data: afterBad } = await supabaseAdmin
    .from('vendors')
    .select('khata_amber_limit, khata_red_limit')
    .eq('id', vendor.id)
    .single();
  expect(Number(afterBad?.khata_amber_limit)).toBe(0);
  expect(Number(afterBad?.khata_red_limit)).toBe(0);

  const { error: ok } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { khata_amber_limit: 500, khata_red_limit: 1000 },
  });
  expect(ok, ok?.message).toBeNull();

  const { data: afterOk } = await supabaseAdmin
    .from('vendors')
    .select('khata_amber_limit, khata_red_limit')
    .eq('id', vendor.id)
    .single();
  expect(Number(afterOk?.khata_amber_limit)).toBe(500);
  expect(Number(afterOk?.khata_red_limit)).toBe(1000);

  // Disable (both zero) still allowed via red = 0.
  const { error: off } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { khata_amber_limit: 0, khata_red_limit: 0 },
  });
  expect(off, off?.message).toBeNull();
});
