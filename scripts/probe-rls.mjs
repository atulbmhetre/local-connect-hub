/**
 * Probes which RLS operations the anon role can perform on
 * vendor_categories / vendor_verification, using a throwaway inactive
 * test vendor. Cleans up after itself via the service role.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL;
const anon = createClient(url, process.env.VITE_SUPABASE_ANON_KEY);
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY);

const report = (op, error, extra = '') =>
  console.log(`${op.padEnd(42)} ${error ? `BLOCKED/FAILED (${error.code}: ${error.message})` : `OK ${extra}`}`);

// --- setup (service role) ---
const { data: cats } = await admin.from('categories').select('id, label').eq('is_active', true).limit(2);
const [catA, catB] = cats;

const { data: vendor, error: vErr } = await admin
  .from('vendors')
  .insert({
    name: 'RLS Probe',
    shop_name: `RLS Probe ${Date.now()}`,
    phone: `97000${Date.now().toString().slice(-5)}`,
    category: catA.label,
    service_mode: 'help',
    latitude: 0,
    longitude: 0,
    is_active: false,
    vendor_note: 'rls_probe:cleanup',
  })
  .select()
  .single();
if (vErr) throw vErr;

const { error: seedVcErr } = await admin.from('vendor_categories').insert({
  vendor_id: vendor.id, category_id: catA.id, is_primary: true, status: 'approved', needs_review: false, service_mode: 'help',
});
if (seedVcErr) throw seedVcErr;
const { error: seedVerErr } = await admin.from('vendor_verification').insert({
  vendor_id: vendor.id, check_type: 'upi_format', status: 'passed', checked_by: 'system', is_latest: true,
});
if (seedVerErr) throw seedVerErr;

console.log(`probe vendor: ${vendor.id}\n`);

// --- anon probes ---
// SELECT
{
  const { data, error } = await anon.from('vendor_categories').select('vendor_id').eq('vendor_id', vendor.id);
  report('vendor_categories SELECT (anon)', error, `rows=${data?.length ?? 0}${(data?.length ?? 0) === 0 ? ' <-- RLS hides rows' : ''}`);
}
{
  const { data, error } = await anon.from('vendor_verification').select('vendor_id').eq('vendor_id', vendor.id);
  report('vendor_verification SELECT (anon)', error, `rows=${data?.length ?? 0}${(data?.length ?? 0) === 0 ? ' <-- RLS hides rows' : ''}`);
}
// INSERT
{
  const { error } = await anon.from('vendor_categories').insert({
    vendor_id: vendor.id, category_id: catB.id, is_primary: false, status: 'approved', needs_review: false, service_mode: 'help',
  });
  report('vendor_categories INSERT (anon)', error);
}
{
  const { error } = await anon.from('vendor_verification').insert({
    vendor_id: vendor.id, check_type: 'gps', status: 'pending', checked_by: 'system', is_latest: true,
  });
  report('vendor_verification INSERT (anon)', error);
}
// UPDATE (Settings.setAdminCheckStatus pattern)
{
  const { data, error } = await anon
    .from('vendor_verification')
    .update({ is_latest: false })
    .eq('vendor_id', vendor.id)
    .eq('check_type', 'upi_format')
    .select();
  report('vendor_verification UPDATE (anon)', error, `rows=${data?.length ?? 0}${(data?.length ?? 0) === 0 ? ' <-- silently updated nothing' : ''}`);
}
// DELETE (VendorMode shop-edit pattern)
{
  const { data, error } = await anon.from('vendor_categories').delete().eq('vendor_id', vendor.id).select();
  report('vendor_categories DELETE (anon)', error, `rows=${data?.length ?? 0}${(data?.length ?? 0) === 0 ? ' <-- silently deleted nothing' : ''}`);
}

// --- cleanup (service role) ---
await admin.from('vendor_verification').delete().eq('vendor_id', vendor.id);
await admin.from('vendor_categories').delete().eq('vendor_id', vendor.id);
await admin.from('vendors').delete().eq('id', vendor.id);
console.log('\ncleanup done');
