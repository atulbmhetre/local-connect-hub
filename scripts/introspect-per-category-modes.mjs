/**
 * READ-ONLY introspection of TEST to determine how far
 * 20260718100001_per_category_availability_modes.sql got before failing.
 * Uses PostgREST (service role). No writes.
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

const results = {};

async function probeColumn(table, column) {
  const { error } = await db.from(table).select(`id, ${column}`).limit(1);
  if (!error) return true;
  if (/column .* does not exist/i.test(error.message) || error.code === '42703') return false;
  return `UNKNOWN(${error.code}: ${error.message})`;
}

async function probeCount(table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) return `ERR(${error.code}: ${error.message})`;
  return count;
}

async function probeRpcExists(fn, args) {
  const { error } = await db.rpc(fn, args);
  if (!error) return { exists: true, note: 'ok' };
  // PGRST202 = function signature not found in schema cache
  if (error.code === 'PGRST202' || /Could not find the function/i.test(error.message)) {
    return { exists: false, note: error.message };
  }
  // Any other error means the function WAS found and executed into its body.
  return { exists: true, note: `${error.code}: ${error.message}` };
}

async function main() {
  console.log('=== INTROSPECT TEST:', url, '===\n');

  // Section 4: requests.service_mode column
  results['requests.service_mode (sec 4)'] = await probeColumn('requests', 'service_mode');

  // Section 3: data repair seeds vendor_category_modes from 28 -> 64
  results['vendor_category_modes count (sec 3 repair; 28=before,64=after)'] =
    await probeCount('vendor_category_modes');
  results['vendor_categories count'] = await probeCount('vendor_categories');
  results['vendor_availability_modes count'] = await probeCount('vendor_availability_modes');

  // Section 10: get_radar_category_mode_matches
  results['get_radar_category_mode_matches (sec 10)'] = await probeRpcExists(
    'get_radar_category_mode_matches',
    { p_mode: 'help', p_category_ids: null },
  );

  // Section 11: create_customer_request new signature (has p_service_mode).
  // Use a non-existent vendor so it fails early (vendor_not_found) WITHOUT inserting,
  // but only if the new signature exists. Old signature -> PGRST202.
  results['create_customer_request(p_service_mode) (sec 11)'] = await probeRpcExists(
    'create_customer_request',
    {
      p_device_id: 'introspect-noop',
      p_vendor_id: '00000000-0000-0000-0000-000000000000',
      p_message: 'introspect',
      p_service_mode: 'help',
    },
  );

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('introspect failed:', e.message);
  process.exit(2);
});
