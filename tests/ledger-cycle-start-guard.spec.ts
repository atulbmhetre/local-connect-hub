import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin, getActiveCategoryByLabel, seedVendorCategory } from './helpers/setup';

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdCustomerPhones: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + createdCustomerPhones.length + 1).slice(-5)}`;
  return phone;
}

async function seedVendor(shopName: string) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const phone = nextPhone('99096');
  createdPhones.push(phone);
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Ledger Cycle Guard Vendor',
      shop_name: shopName,
      phone,
      category: cat.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: 'complete',
      service_radius_km: 15,
      ledger_cycle_start: '2025-11-01',
      khata_amber_limit: 500,
      khata_red_limit: 1000,
    })
    .select('id, phone, ledger_cycle_start')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return data as { id: string; phone: string; ledger_cycle_start: string };
}

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('khata_ledger').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of [...createdPhones, ...createdCustomerPhones]) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('LCS-01 — ledger_cycle_start blocked while outstanding; allowed after settle', async () => {
  const vendor = await seedVendor(`!LCS01-${T}`);
  const customerPhone = nextPhone('88096');
  createdCustomerPhones.push(customerPhone);

  const { error: ledgerErr } = await supabaseAdmin.from('khata_ledger').insert({
    vendor_id: vendor.id,
    user_phone: customerPhone,
    total_outstanding: 250,
  });
  expect(ledgerErr, ledgerErr?.message).toBeNull();

  const blockedDate = '2026-01-15';
  const { error: blocked } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { ledger_cycle_start: blockedDate },
  });
  expect(blocked?.message ?? '').toContain('ledger_cycle_change_blocked');

  const { data: stillOld } = await supabaseAdmin
    .from('vendors')
    .select('ledger_cycle_start')
    .eq('id', vendor.id)
    .single();
  expect(stillOld?.ledger_cycle_start).toBe('2025-11-01');

  // Credit limits remain changeable while outstanding (intentional — not gated).
  const { error: limitsOk } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { khata_amber_limit: 600, khata_red_limit: 1200 },
  });
  expect(limitsOk, limitsOk?.message).toBeNull();

  const { error: settleErr } = await supabaseAdmin
    .from('khata_ledger')
    .update({ total_outstanding: 0 })
    .eq('vendor_id', vendor.id)
    .eq('user_phone', customerPhone);
  expect(settleErr, settleErr?.message).toBeNull();

  const allowedDate = '2026-01-15';
  const { error: allowed } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { ledger_cycle_start: allowedDate },
  });
  expect(allowed, allowed?.message).toBeNull();

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('ledger_cycle_start')
    .eq('id', vendor.id)
    .single();
  expect(after?.ledger_cycle_start).toBe(allowedDate);
});
