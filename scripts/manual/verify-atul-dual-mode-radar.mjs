/**
 * MANUAL verification tool (not part of the automated test suite).
 *
 * Live TEST check for Atul's dual-mode scenario:
 *   vendor with Mess/Food (Help) + Milk Delivery (Delivery),
 *   explicit distinct per-category modes (not inherited defaults).
 * Then anon Radar discovery for Help / Delivery / Appointment.
 *
 * Usage (from repo root, with .env.test loaded keys):
 *   node scripts/manual/verify-atul-dual-mode-radar.mjs
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !anonKey || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env.test');
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
  console.log('=== LIVE VERIFY: Atul dual-mode Radar discovery (TEST) ===\n');
  console.log('Supabase URL:', url);

  const { data: categories, error: catErr } = await admin
    .from('categories')
    .select('id, label, service_mode, is_active')
    .eq('is_active', true)
    .order('label');
  if (catErr) throw catErr;

  // TEST has no "Mess" row. Closest food category is "Cook" (catalog default: appointment).
  // Closest milk category is "Dairy" (catalog default: delivery).
  // We deliberately set Cook → help (OVERRIDING appointment default) and Dairy → delivery
  // so modes are explicit and not merely inherited scalars.
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
    console.log('\nAvailable active categories (for debugging):');
    for (const c of categories) {
      console.log(`  [${c.service_mode}] ${c.label} (${c.id})`);
    }
    process.exitCode = 1;
    return;
  }

  // Explicit distinct modes — Help-only on food category, Delivery-only on milk.
  // Cook's catalog default is appointment; forcing help proves non-inherited authority.
  const phone = `99119${Date.now().toString().slice(-5)}`;
  const shopName = `Atul Dual Live ${Date.now().toString().slice(-6)}`;
  const categoryModes = {
    [mess.id]: ['help'],
    [milk.id]: ['delivery'],
  };
  console.log('\nNOTE: catalog defaults vs explicit modes:');
  console.log(`  ${mess.label}: catalog=${mess.service_mode} → explicit child modes=['help']`);
  console.log(`  ${milk.label}: catalog=${milk.service_mode} → explicit child modes=['delivery']`);

  console.log('\n--- Seeding vendor ---');
  console.log('phone:', phone);
  console.log('shop_name:', shopName);
  console.log('explicit p_category_modes:', categoryModes);

  const { data: vendorId, error: regErr } = await admin.rpc('register_vendor', {
    p_name: 'Atul Live Dual',
    p_shop_name: shopName,
    p_category: mess.label,
    p_phone: phone,
    p_upi_id: 'atul-live@upi',
    p_service_mode: 'help',
    p_vendor_type: 'shop',
    p_vendor_note: `live_verify:atul_dual_mode:${Date.now()}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `AL${Date.now().toString(36).slice(-6)}`.toUpperCase(),
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
    console.error('register_vendor failed:', regErr);
    process.exitCode = 1;
    return;
  }
  console.log('vendor_id:', vendorId);

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
  for (const m of modeRows ?? []) {
    (modeByVc[m.vendor_category_id] ??= []).push(m.mode);
  }
  for (const vc of vcRows ?? []) {
    const cat = vc.category_id === mess.id ? mess.label : milk.label;
    console.log(`  ${cat} (${vc.category_id}): modes=${JSON.stringify(modeByVc[vc.id] ?? [])}`);
  }

  async function runRadar(label, { mode, categoryIds }) {
    const args = { p_mode: mode, p_category_ids: categoryIds };
    const { data, error } = await anon.rpc('get_radar_category_mode_matches', args);
    const ourRows = (data ?? []).filter((r) => r.vendor_id === vendorId);
    console.log(`\n=== Radar discovery: ${label} ===`);
    console.log('caller: anon (no session)');
    console.log('rpc: get_radar_category_mode_matches');
    console.log('args:', JSON.stringify(args));
    if (error) {
      console.log('error:', error);
      return { error, ourRows: [], allCount: 0 };
    }
    console.log(`total match rows returned: ${(data ?? []).length}`);
    console.log(`rows for seeded vendor ${vendorId}:`, JSON.stringify(ourRows, null, 2));
    console.log(`seeded vendor appears: ${ourRows.length > 0 ? 'YES' : 'NO'}`);
    return { error: null, ourRows, allCount: (data ?? []).length, data };
  }

  // Help tab searching Mess/Food → expect match via mess category
  const help = await runRadar('Help tab × Mess/Food category', {
    mode: 'help',
    categoryIds: [mess.id],
  });

  // Delivery tab searching Milk → expect match via milk category
  const delivery = await runRadar('Delivery tab × Milk category', {
    mode: 'delivery',
    categoryIds: [milk.id],
  });

  // Appointment tab with both categories (and empty browse) → must NOT appear
  const apptScoped = await runRadar('Appointment tab × both categories', {
    mode: 'appointment',
    categoryIds: [mess.id, milk.id],
  });
  const apptBrowse = await runRadar('Appointment tab × empty browse (all categories)', {
    mode: 'appointment',
    categoryIds: null,
  });

  // Cross-checks: Help must not match via milk-only search; Delivery must not match via mess-only
  const helpViaMilk = await runRadar('CONTROL Help tab × Milk category (should miss)', {
    mode: 'help',
    categoryIds: [milk.id],
  });
  const deliveryViaMess = await runRadar('CONTROL Delivery tab × Mess category (should miss)', {
    mode: 'delivery',
    categoryIds: [mess.id],
  });

  console.log('\n=== VERDICT ===');
  const passHelp = help.ourRows.length > 0 && help.ourRows.some((r) => r.category_id === mess.id);
  const passDelivery = delivery.ourRows.length > 0 && delivery.ourRows.some((r) => r.category_id === milk.id);
  const passApptAbsent = apptScoped.ourRows.length === 0 && apptBrowse.ourRows.length === 0;
  const passControls = helpViaMilk.ourRows.length === 0 && deliveryViaMess.ourRows.length === 0;

  console.log(`Help tab finds vendor via ${mess.label}:          ${passHelp ? 'PASS' : 'FAIL'}`);
  console.log(`Delivery tab finds vendor via ${milk.label}:     ${passDelivery ? 'PASS' : 'FAIL'}`);
  console.log(`Appointment tab does NOT find vendor:             ${passApptAbsent ? 'PASS' : 'FAIL'}`);
  console.log(`Cross-tab category leakage controls:              ${passControls ? 'PASS' : 'FAIL'}`);

  // Cleanup
  console.log('\n--- Cleanup ---');
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
  await admin.from('vendors').delete().eq('id', vendorId);
  console.log('deleted vendor', vendorId);

  const ok = passHelp && passDelivery && passApptAbsent && passControls;
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
