/**
 * Read-only vendor diagnostics for PROD delta and TEST bloat analysis.
 * Usage:
 *   node scripts/diagnose-vendors-readonly.mjs prod > prod_vendor_delta.txt 2>&1
 *   node scripts/diagnose-vendors-readonly.mjs test > test_vendor_bloat.txt 2>&1
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const mode = process.argv[2] ?? 'prod';

const envFile = mode === 'prod' ? '.env.test.prod' : '.env.test';
const envPath = path.resolve(projectRoot, envFile);
if (!fs.existsSync(envPath)) {
  console.error(`Missing ${envPath}`);
  process.exit(1);
}
dotenv.config({ path: envPath, override: true });

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const db = createClient(url, key, { auth: { persistSession: false } });

const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '?';
console.log(`=== Vendor diagnostics (${mode.toUpperCase()}) ===`);
console.log(`project_ref: ${ref}`);

const PAGE = 1000;
let all = [];
let from = 0;
while (true) {
  const { data, error } = await db
    .from('vendors')
    .select('id, phone, name, shop_name, created_at, vendor_note, is_active')
    .order('created_at', { ascending: true })
    .range(from, from + PAGE - 1);
  if (error) {
    console.error('query error:', error.message);
    process.exit(1);
  }
  if (!data?.length) break;
  all.push(...data);
  if (data.length < PAGE) break;
  from += PAGE;
}
console.log(`total_vendors: ${all.length}`);

const isTestPhone = (p) =>
  /^99000\d{4}$/.test(p) ||
  /^88000\d{4}$/.test(p) ||
  /^99999\d{4}$/.test(p) ||
  /^91\d{10}$/.test(p) && p.startsWith('9199');

const isTestName = (n, s) =>
  /^Test Vendor /i.test(n ?? '') ||
  /^Test Shop /i.test(s ?? '') ||
  (n ?? '').includes('test_session:') ||
  (s ?? '').includes('test_session:');

const isTestNote = (note) => (note ?? '').includes('test_session:');

function classify(v) {
  if (isTestPhone(v.phone)) return 'test_phone_pattern';
  if (isTestName(v.name, v.shop_name)) return 'test_name_pattern';
  if (isTestNote(v.vendor_note)) return 'test_note_pattern';
  return 'other';
}

if (mode === 'prod') {
  // Baseline before run was 2026-07-04 ~19:55 UTC (canary_before)
  const baseline = '2026-07-04T19:00:00.000Z';
  const recent = all.filter((v) => v.created_at >= baseline);
  console.log(`\n--- Vendors created since ${baseline} (${recent.length}) ---`);
  for (const v of recent) {
    console.log(
      JSON.stringify({
        phone: v.phone,
        created_at: v.created_at,
        name: v.name,
        shop_name: v.shop_name,
        is_active: v.is_active,
        classification: classify(v),
        vendor_note: v.vendor_note?.slice(0, 80) ?? null,
      }),
    );
  }
  console.log('\n--- All vendors by created_at (full list) ---');
  for (const v of all) {
    console.log(`${v.created_at}\t${v.phone}\t${v.name}\t${classify(v)}`);
  }
} else {
  // TEST bloat analysis
  const byDay = {};
  const byClass = { test_phone_pattern: 0, test_name_pattern: 0, test_note_pattern: 0, other: 0 };
  for (const v of all) {
    const day = v.created_at.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
    byClass[classify(v)]++;
  }
  console.log('\n--- created_at daily distribution (last 30 days with data) ---');
  const days = Object.keys(byDay).sort();
  const last30 = days.slice(-30);
  for (const d of last30) {
    console.log(`${d}: ${byDay[d]}`);
  }
  if (days.length > 30) {
    const older = days.slice(0, -30);
    const olderTotal = older.reduce((s, d) => s + byDay[d], 0);
    console.log(`... ${older.length} earlier days combined: ${olderTotal}`);
  }
  console.log('\n--- classification totals ---');
  for (const [k, n] of Object.entries(byClass)) {
    console.log(`${k}: ${n} (${((n / all.length) * 100).toFixed(1)}%)`);
  }
  // Phone prefix breakdown for test-like phones
  const prefixes = {};
  for (const v of all) {
    const pre = v.phone?.slice(0, 5) ?? '?????';
    prefixes[pre] = (prefixes[pre] ?? 0) + 1;
  }
  console.log('\n--- top phone prefixes ---');
  Object.entries(prefixes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .forEach(([p, n]) => console.log(`${p}*: ${n}`));
  // Today specifically (2026-07-04 and 2026-07-05)
  for (const d of ['2026-07-04', '2026-07-05']) {
    const dayRows = all.filter((v) => v.created_at.startsWith(d));
    const testLike = dayRows.filter((v) => classify(v) !== 'other');
    console.log(`\n--- ${d}: ${dayRows.length} created, ${testLike.length} test-like ---`);
  }
  const earliest = all[0]?.created_at;
  const latest = all[all.length - 1]?.created_at;
  console.log(`\nearliest: ${earliest}`);
  console.log(`latest: ${latest}`);
}

console.log('\nstatus: ok');
