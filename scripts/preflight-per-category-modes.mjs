/**
 * READ-ONLY preflight for 20260718100001_per_category_availability_modes.sql.
 * Verifies TEST data matches expectations BEFORE the migration's cleanup/repair runs.
 * Performs only SELECTs. No writes.
 *
 * Reports:
 *   - duplicate (vendor_id, category_id) rows in vendor_categories
 *   - vendors with more than one is_primary=true row
 *   - vendor_categories rows with NO child mode set (will be seeded from scalar)
 *   - vendor_categories rows WHERE scalar service_mode not in child set (with a set)
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test');
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false } });

async function fetchAll(table, columns) {
  const pageSize = 1000;
  let from = 0;
  const rows = [];
  for (;;) {
    const { data, error } = await db
      .from(table)
      .select(columns)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

const CANON = ['help', 'delivery', 'appointment'];
function pickPrimary(modes, catalog) {
  const norm = CANON.filter((m) => modes.includes(m));
  if (norm.length === 0) return 'help';
  const c = String(catalog ?? '').toLowerCase().trim();
  if (CANON.includes(c) && norm.includes(c)) return c;
  return norm[0];
}

async function main() {
  const vcRows = await fetchAll(
    'vendor_categories',
    'id, vendor_id, category_id, is_primary, service_mode, status',
  );
  const vcmRows = await fetchAll('vendor_category_modes', 'vendor_category_id, mode');
  const catRows = await fetchAll('categories', 'id, service_mode');

  const catMode = new Map(catRows.map((c) => [c.id, c.service_mode]));

  const modesByVc = new Map();
  for (const m of vcmRows) {
    if (!modesByVc.has(m.vendor_category_id)) modesByVc.set(m.vendor_category_id, []);
    modesByVc.get(m.vendor_category_id).push(String(m.mode).toLowerCase().trim());
  }

  // 1. Duplicate (vendor_id, category_id)
  const pairCount = new Map();
  for (const vc of vcRows) {
    const k = `${vc.vendor_id}::${vc.category_id}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  const dupPairs = [...pairCount.entries()].filter(([, n]) => n > 1);

  // 2. Vendors with >1 primary
  const primaryCount = new Map();
  for (const vc of vcRows) {
    if (vc.is_primary === true) {
      primaryCount.set(vc.vendor_id, (primaryCount.get(vc.vendor_id) ?? 0) + 1);
    }
  }
  const multiPrimary = [...primaryCount.entries()].filter(([, n]) => n > 1);

  // 3. vendor_categories with NO child mode set
  const noChildSet = vcRows.filter((vc) => (modesByVc.get(vc.id) ?? []).length === 0);

  // 4. scalar not in child set (only for rows that HAVE a child set)
  const scalarNotInSet = vcRows.filter((vc) => {
    const modes = modesByVc.get(vc.id) ?? [];
    if (modes.length === 0) return false;
    const scalar = String(vc.service_mode ?? '').toLowerCase().trim();
    return scalar !== '' && !modes.includes(scalar);
  });

  // Informational: what the scalar repair would change (primary differs from current scalar).
  const scalarWouldChange = vcRows.filter((vc) => {
    const modes = modesByVc.get(vc.id) ?? [COALESCEmode(vc)];
    const primary = pickPrimary(
      modes.length ? modes : [COALESCEmode(vc)],
      catMode.get(vc.category_id),
    );
    return (vc.service_mode ?? null) !== primary;
  });
  function COALESCEmode(vc) {
    return String(vc.service_mode ?? 'help').toLowerCase().trim() || 'help';
  }

  const total = vcRows.length;
  const out = {
    vendor_categories_total: total,
    vendor_category_modes_rows: vcmRows.length,
    duplicate_vendor_category_pairs: dupPairs.length,
    vendors_with_multiple_primary: multiPrimary.length,
    rows_with_no_child_set: noChildSet.length,
    rows_scalar_not_in_child_set: scalarNotInSet.length,
    rows_scalar_would_be_rederived: scalarWouldChange.length,
  };

  console.log('=== PREFLIGHT: per-category availability modes (TEST, READ-ONLY) ===');
  console.log(`project: ${url}`);
  console.log(JSON.stringify(out, null, 2));

  console.log('\n--- Expectations (from plan) ---');
  console.log(`rows_with_no_child_set expected: 36 / 64`);
  console.log(`known inconsistency baseline: 12 / 64`);

  const problems = [];
  if (dupPairs.length > 0) {
    problems.push(`duplicate (vendor_id,category_id) rows: ${dupPairs.length} (expected 0)`);
    for (const [k, n] of dupPairs.slice(0, 20)) problems.push(`   dup ${k} x${n}`);
  }
  if (multiPrimary.length > 0) {
    problems.push(`vendors with >1 primary: ${multiPrimary.length} (expected 0)`);
    for (const [k, n] of multiPrimary.slice(0, 20)) problems.push(`   vendor ${k} x${n}`);
  }
  if (total !== 64) {
    problems.push(
      `vendor_categories_total is ${total}, not the previously-reported 64 (dataset changed; review before proceeding)`,
    );
  }
  if (noChildSet.length > 36) {
    problems.push(
      `rows_with_no_child_set is ${noChildSet.length} > 36 (more than previously reported)`,
    );
  }
  if (scalarNotInSet.length > 12) {
    problems.push(
      `rows_scalar_not_in_child_set is ${scalarNotInSet.length} > 12 (more inconsistency than previously reported)`,
    );
  }

  if (problems.length > 0) {
    console.log('\n*** STOP: unexpected data — do NOT apply the migration ***');
    for (const p of problems) console.log(` - ${p}`);
    process.exit(1);
  }

  console.log('\nOK: data matches expectations (no dup rows, no multi-primary, <=36 empty sets, <=12 scalar inconsistencies).');
  console.log('Safe to apply migration.');
  process.exit(0);
}

main().catch((e) => {
  console.error('preflight failed:', e.message);
  process.exit(2);
});
