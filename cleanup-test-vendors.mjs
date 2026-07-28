// cleanup-test-vendors.mjs
//
// Removes every TEST_-prefixed vendor created by seed-test-vendors.mjs,
// along with their dependent rows, in the correct order.
//
// Run with:
//   node cleanup-test-vendors.mjs
//
// Reads .env.test.prod for the PROD URL + service-role key (same as the
// seed script). Safe to run whenever you want a clean slate before
// re-seeding — only ever touches rows whose shop_name starts with "TEST_".

import 'dotenv/config';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const env = dotenv.parse(await import('node:fs').then(fs => fs.readFileSync('.env.test.prod')));
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test.prod');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

console.log(`Target: ${SUPABASE_URL}`);
if (!SUPABASE_URL.includes('rpxsyeqskvhjmbkxnpmd')) {
  console.error('Refusing to run — this does not look like the PROD project ref.');
  process.exit(1);
}

async function main() {
  const { data: testVendors, error: findErr } = await sb
    .from('vendors')
    .select('id, shop_name')
    .like('shop_name', 'TEST_%');

  if (findErr) {
    console.error('Failed to look up TEST_ vendors:', findErr.message);
    process.exit(1);
  }

  if (!testVendors || testVendors.length === 0) {
    console.log('No TEST_ vendors found — nothing to clean up.');
    return;
  }

  console.log(`Found ${testVendors.length} TEST_ vendors. Deleting dependent rows first...`);
  const ids = testVendors.map((v) => v.id);

  // vendor_menu_items no longer cascades (tonight's FK hardening) — delete manually first.
  const { error: menuErr, count: menuCount } = await sb
    .from('vendor_menu_items')
    .delete({ count: 'exact' })
    .in('vendor_id', ids);
  if (menuErr) console.error('  vendor_menu_items delete error:', menuErr.message);
  else console.log(`  vendor_menu_items removed: ${menuCount ?? 'unknown count'}`);

  // vendor_categories, vendor_availability_modes, vendor_verification all still
  // cascade automatically on vendor delete — no manual step needed for those.

  const { error: vErr, count: vCount } = await sb
    .from('vendors')
    .delete({ count: 'exact' })
    .in('id', ids);
  if (vErr) {
    console.error('  vendors delete error:', vErr.message);
    process.exit(1);
  }
  console.log(`  vendors removed: ${vCount ?? ids.length}`);
  console.log('\nCleanup complete.');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
