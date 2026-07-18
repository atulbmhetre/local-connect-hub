/**
 * MANUAL read-only probe of PROD per-category availability state.
 * 1. Does get_radar_category_mode_matches exist (anon call)?
 * 2. Does vendor_category_modes exist, and does any real vendor already
 *    have two categories with genuinely different child-mode sets?
 * No writes.
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
console.log('PROD URL:', url);

const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

// 1. RPC existence (anon, read-only)
const rpcProbe = await anon.rpc('get_radar_category_mode_matches', {
  p_mode: 'help',
  p_category_ids: null,
});
if (rpcProbe.error) {
  console.log('\nRPC get_radar_category_mode_matches (anon): ERROR');
  console.log(JSON.stringify(rpcProbe.error, null, 2));
} else {
  console.log('\nRPC get_radar_category_mode_matches (anon): EXISTS');
  console.log('help empty-browse rows:', (rpcProbe.data ?? []).length);
}

// 2. vendor_category_modes table probe (service role, read-only)
const vcmProbe = await admin.from('vendor_category_modes').select('id', { count: 'exact', head: true });
if (vcmProbe.error) {
  console.log('\nTable vendor_category_modes: ERROR ->', vcmProbe.error.message);
} else {
  console.log('\nTable vendor_category_modes: EXISTS, total rows:', vcmProbe.count);
}

// 3. Existing multi-category vendors with differing mode sets (read-only)
if (!vcmProbe.error) {
  const { data: vcRows, error: vcErr } = await admin
    .from('vendor_categories')
    .select('id, vendor_id, category_id, service_mode, status');
  if (vcErr) {
    console.log('vendor_categories read error:', vcErr.message);
  } else {
    const byVendor = new Map();
    for (const r of vcRows ?? []) {
      (byVendor.get(r.vendor_id) ?? byVendor.set(r.vendor_id, []).get(r.vendor_id)).push(r);
    }
    const multi = [...byVendor.entries()].filter(([, rows]) => rows.length > 1);
    console.log('\nvendors with >1 category:', multi.length, 'of', byVendor.size, 'total vendors with categories');

    const vcIds = multi.flatMap(([, rows]) => rows.map((r) => r.id));
    let modesByVc = new Map();
    if (vcIds.length) {
      const { data: modeRows, error: mErr } = await admin
        .from('vendor_category_modes')
        .select('vendor_category_id, mode')
        .in('vendor_category_id', vcIds);
      if (mErr) console.log('vendor_category_modes read error:', mErr.message);
      for (const m of modeRows ?? []) {
        (modesByVc.get(m.vendor_category_id) ?? modesByVc.set(m.vendor_category_id, []).get(m.vendor_category_id)).push(m.mode);
      }
    }

    const candidates = [];
    for (const [vendorId, rows] of multi) {
      const sets = rows.map((r) => (modesByVc.get(r.id) ?? []).slice().sort().join('+') || `(none:${r.service_mode})`);
      const distinct = new Set(sets);
      if (distinct.size > 1) candidates.push({ vendorId, rows, sets });
    }
    console.log('vendors with DIFFERENT mode sets across categories:', candidates.length);
    for (const c of candidates.slice(0, 10)) {
      console.log(`  vendor ${c.vendorId}:`);
      c.rows.forEach((r, i) => {
        console.log(`    category ${r.category_id} status=${r.status} scalar=${r.service_mode} modes=[${c.sets[i]}]`);
      });
    }
  }
}
