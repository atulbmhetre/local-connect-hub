/**
 * MANUAL verification tool (not part of the automated test suite).
 *
 * PROD live check for Atul's dual-mode scenario using a TEMPORARY throwaway
 * vendor (cleaned up at the end): two categories with explicitly different
 * per-category modes (one help, one delivery), then anon Radar discovery for
 * Help / Delivery / Appointment plus cross-leak controls.
 *
 * Usage: node scripts/manual/verify-prod-atul-dual-mode.mjs
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test.prod' });

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('Missing PROD env values in .env.test.prod');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

function pickByLabel(rows, labelRe, prefer) {
  const byLabel = rows.filter((r) => labelRe.test(r.label ?? '') && !String(r.label).startsWith('!'));
  if (prefer) {
    const preferred = byLabel.find((r) => prefer.test(r.label ?? ''));
    if (preferred) return preferred;
  }
  return byLabel[0] ?? null;
}

async function main() {
  console.log('=== PROD LIVE VERIFY: Atul dual-mode Radar discovery ===\n');
  console.log('Supabase URL:', url);

  const { data: categories, error: catErr } = await admin
    .from('categories')
    .select('id, label, service_mode, is_active')
    .eq('is_active', true)
    .order('label');
  if (catErr) throw catErr;

  console.log('\nActive PROD categories:');
  for (const c of categories) console.log(`  [${c.service_mode}] ${c.label} (${c.id})`);

  const mess = pickByLabel(categories, /mess|food|cook|tiffin|kitchen|canteen/i, /mess|cook|food/i);
  const milk = pickByLabel(categories, /milk|dairy/i, /milk|dairy/i);

  console.log('\n--- Category selection ---');
  console.log('Food-side (Mess stand-in):', mess
    ? { id: mess.id, label: mess.label, catalog_service_mode: mess.service_mode }
    : 'NOT FOUND');
  console.log('Milk-side:', milk
    ? { id: milk.id, label: milk.label, catalog_service_mode: milk.service_mode }
    : 'NOT FOUND');
  if (!mess || !milk) {
    console.error('Could not find suitable categories on PROD; aborting without writes.');
    process.exitCode = 1;
    return;
  }

  const phone = `99229${Date.now().toString().slice(-5)}`;
  const shopName = `ZZ Verify Dual ${Date.now().toString().slice(-6)}`;
  const categoryModes = {
    [mess.id]: ['help'],
    [milk.id]: ['delivery'],
  };
  console.log('\nExplicit per-category modes (not inherited):');
  console.log(`  ${mess.label}: catalog=${mess.service_mode} → explicit ['help']`);
  console.log(`  ${milk.label}: catalog=${milk.service_mode} → explicit ['delivery']`);

  console.log('\n--- Seeding throwaway vendor (PROD) ---');
  console.log('phone:', phone, '| shop_name:', shopName);

  const { data: vendorId, error: regErr } = await admin.rpc('register_vendor', {
    p_name: 'ZZ Verify Dual',
    p_shop_name: shopName,
    p_category: mess.label,
    p_phone: phone,
    p_upi_id: 'zz-verify@upi',
    p_service_mode: 'help',
    p_vendor_type: 'shop',
    p_vendor_note: `live_verify:prod_dual_mode:${Date.now()}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `ZV${Date.now().toString(36).slice(-6)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [mess.id, milk.id],
    p_category_service_modes: ['help', 'delivery'],
    p_category_modes: categoryModes,
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 9999,
    p_availability_modes: ['help', 'delivery'],
  });
  if (regErr) {
    console.error('register_vendor failed on PROD:', regErr);
    process.exitCode = 1;
    return;
  }
  console.log('vendor_id:', vendorId);

  try {
    await admin
      .from('vendors')
      .update({ is_active: true, discoverable: true, profile_status: 'complete' })
      .eq('id', vendorId);
    await admin
      .from('vendor_categories')
      .update({ status: 'approved', needs_review: false })
      .eq('vendor_id', vendorId);

    const { data: vcRows } = await admin
      .from('vendor_categories')
      .select('id, category_id, service_mode, is_primary, status')
      .eq('vendor_id', vendorId);
    console.log('\n--- Persisted vendor_categories ---');
    console.log(JSON.stringify(vcRows, null, 2));

    const vcIds = (vcRows ?? []).map((r) => r.id);
    const { data: modeRows } = await admin
      .from('vendor_category_modes')
      .select('vendor_category_id, mode')
      .in('vendor_category_id', vcIds);
    console.log('\n--- Persisted vendor_category_modes (authoritative) ---');
    const modeByVc = {};
    for (const m of modeRows ?? []) (modeByVc[m.vendor_category_id] ??= []).push(m.mode);
    for (const vc of vcRows ?? []) {
      const cat = vc.category_id === mess.id ? mess.label : milk.label;
      console.log(`  ${cat} (${vc.category_id}): modes=${JSON.stringify(modeByVc[vc.id] ?? [])}`);
    }

    async function runRadar(label, { mode, categoryIds }) {
      const args = { p_mode: mode, p_category_ids: categoryIds };
      const { data, error } = await anon.rpc('get_radar_category_mode_matches', args);
      const ourRows = (data ?? []).filter((r) => r.vendor_id === vendorId);
      console.log(`\n=== Radar discovery: ${label} ===`);
      console.log('caller: anon (no session) | rpc: get_radar_category_mode_matches');
      console.log('args:', JSON.stringify(args));
      if (error) {
        console.log('error:', error);
        return { error, ourRows: [] };
      }
      console.log(`total match rows returned: ${(data ?? []).length}`);
      console.log(`rows for seeded vendor ${vendorId}:`, JSON.stringify(ourRows, null, 2));
      console.log(`seeded vendor appears: ${ourRows.length > 0 ? 'YES' : 'NO'}`);
      return { error: null, ourRows };
    }

    const help = await runRadar(`Help tab × ${mess.label}`, { mode: 'help', categoryIds: [mess.id] });
    const delivery = await runRadar(`Delivery tab × ${milk.label}`, { mode: 'delivery', categoryIds: [milk.id] });
    const apptScoped = await runRadar('Appointment tab × both categories', {
      mode: 'appointment',
      categoryIds: [mess.id, milk.id],
    });
    const apptBrowse = await runRadar('Appointment tab × empty browse', {
      mode: 'appointment',
      categoryIds: null,
    });
    const helpViaMilk = await runRadar(`CONTROL Help tab × ${milk.label} (should miss)`, {
      mode: 'help',
      categoryIds: [milk.id],
    });
    const deliveryViaMess = await runRadar(`CONTROL Delivery tab × ${mess.label} (should miss)`, {
      mode: 'delivery',
      categoryIds: [mess.id],
    });

    console.log('\n=== VERDICT (PROD) ===');
    const passHelp = help.ourRows.some((r) => r.category_id === mess.id);
    const passDelivery = delivery.ourRows.some((r) => r.category_id === milk.id);
    const passApptAbsent = apptScoped.ourRows.length === 0 && apptBrowse.ourRows.length === 0;
    const passControls = helpViaMilk.ourRows.length === 0 && deliveryViaMess.ourRows.length === 0;
    console.log(`Help tab finds vendor via ${mess.label}:      ${passHelp ? 'PASS' : 'FAIL'}`);
    console.log(`Delivery tab finds vendor via ${milk.label}:  ${passDelivery ? 'PASS' : 'FAIL'}`);
    console.log(`Appointment tab does NOT find vendor:         ${passApptAbsent ? 'PASS' : 'FAIL'}`);
    console.log(`Cross-tab leakage controls:                   ${passControls ? 'PASS' : 'FAIL'}`);
    process.exitCode = passHelp && passDelivery && passApptAbsent && passControls ? 0 : 1;
  } finally {
    console.log('\n--- Cleanup (PROD) ---');
    const { data: vcForDelete } = await admin
      .from('vendor_categories')
      .select('id')
      .eq('vendor_id', vendorId);
    const deleteVcIds = (vcForDelete ?? []).map((r) => r.id);
    if (deleteVcIds.length) {
      await admin.from('vendor_category_modes').delete().in('vendor_category_id', deleteVcIds);
    }
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendor_availability_modes').delete().eq('vendor_id', vendorId);
    const del = await admin.from('vendors').delete().eq('id', vendorId);
    if (del.error) console.log('vendor delete error:', del.error.message);

    const { data: still } = await admin.from('vendors').select('id').eq('id', vendorId);
    const { data: stillVc } = await admin.from('vendor_categories').select('id').eq('vendor_id', vendorId);
    console.log(`vendors rows remaining for ${vendorId}: ${(still ?? []).length}`);
    console.log(`vendor_categories rows remaining: ${(stillVc ?? []).length}`);
    console.log((still ?? []).length === 0 && (stillVc ?? []).length === 0
      ? 'CLEANUP CONFIRMED: no residue'
      : 'CLEANUP INCOMPLETE — manual attention needed');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
