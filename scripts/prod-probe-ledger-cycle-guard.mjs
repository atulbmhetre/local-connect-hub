/**
 * One-shot PROD probe for ledger_cycle_start outstanding guard.
 * Seeds, verifies, cleans up. Usage: node scripts/prod-probe-ledger-cycle-guard.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const refMatch = url.match(/https:\/\/([^.]+)\.supabase\.co/);
const ref = refMatch?.[1] ?? '(unknown)';

console.log('=== PROD probe env ===');
console.log('project_ref:', ref);
console.log('expected_prod: rpxsyeqskvhjmbkxnpmd');
if (ref !== 'rpxsyeqskvhjmbkxnpmd') {
  console.error('ABORT: not PROD');
  process.exit(2);
}
if (!url || !anon || !service) {
  console.error('ABORT: missing keys');
  process.exit(2);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const anonClient = createClient(url, anon, { auth: { persistSession: false } });

const T = Date.now();
const vendorPhone = `99097${String(T).slice(-5)}`;
const customerPhone = `88097${String(T).slice(-5)}`;
const shopName = `!LCS-PROD-PROBE-${T}`;

let vendorId = null;

async function cleanup() {
  if (!vendorId) return;
  await admin.from('khata_ledger').delete().eq('vendor_id', vendorId);
  await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await admin.from('vendors').delete().eq('id', vendorId);
  await admin.from('users').delete().eq('phone', vendorPhone);
  await admin.from('users').delete().eq('phone', customerPhone);
}

try {
  const { data: cat, error: catErr } = await admin
    .from('categories')
    .select('id, label')
    .eq('is_active', true)
    .limit(1)
    .single();
  if (catErr) throw catErr;

  const { data: vendor, error: vErr } = await admin
    .from('vendors')
    .insert({
      name: 'LCS PROD Probe',
      shop_name: shopName,
      phone: vendorPhone,
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
    .select('id, phone, ledger_cycle_start, khata_amber_limit, khata_red_limit')
    .single();
  if (vErr) throw vErr;
  vendorId = vendor.id;

  const { error: vcErr } = await admin.from('vendor_categories').insert({
    vendor_id: vendorId,
    category_id: cat.id,
    is_primary: true,
    status: 'approved',
    brand_name: shopName,
  });
  if (vcErr) throw vcErr;

  const { error: ledErr } = await admin.from('khata_ledger').insert({
    vendor_id: vendorId,
    user_phone: customerPhone,
    total_outstanding: 250,
  });
  if (ledErr) throw ledErr;

  console.log('=== seed ===');
  console.log(
    JSON.stringify(
      {
        vendor_id: vendorId,
        vendor_phone: vendorPhone,
        customer_phone: customerPhone,
        shop_name: shopName,
        ledger_cycle_start_before: vendor.ledger_cycle_start,
        amber_before: Number(vendor.khata_amber_limit),
        red_before: Number(vendor.khata_red_limit),
        outstanding: 250,
      },
      null,
      2,
    ),
  );

  const blockedDate = '2026-01-15';
  const { error: blocked } = await anonClient.rpc('vendor_update_own', {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_patch: { ledger_cycle_start: blockedDate },
  });
  console.log('=== cycle-start while outstanding ===');
  console.log('error:', blocked?.message ?? null);

  const { data: afterBlock } = await admin
    .from('vendors')
    .select('ledger_cycle_start, khata_amber_limit, khata_red_limit')
    .eq('id', vendorId)
    .single();
  console.log('ledger_cycle_start_after_block:', afterBlock?.ledger_cycle_start);
  console.log('date_unchanged:', afterBlock?.ledger_cycle_start === '2025-11-01');

  const { error: limitsOk } = await anonClient.rpc('vendor_update_own', {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_patch: { khata_amber_limit: 600, khata_red_limit: 1200 },
  });
  console.log('=== credit limits while outstanding ===');
  console.log('error:', limitsOk?.message ?? null);

  const { data: afterLimits } = await admin
    .from('vendors')
    .select('khata_amber_limit, khata_red_limit, ledger_cycle_start')
    .eq('id', vendorId)
    .single();
  console.log('amber_after:', Number(afterLimits?.khata_amber_limit));
  console.log('red_after:', Number(afterLimits?.khata_red_limit));
  console.log('cycle_still:', afterLimits?.ledger_cycle_start);

  const { error: settleErr } = await admin
    .from('khata_ledger')
    .update({ total_outstanding: 0 })
    .eq('vendor_id', vendorId)
    .eq('user_phone', customerPhone);
  if (settleErr) throw settleErr;
  console.log('=== settled outstanding to 0 ===');

  const allowedDate = '2026-01-15';
  const { error: allowed } = await anonClient.rpc('vendor_update_own', {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_patch: { ledger_cycle_start: allowedDate },
  });
  console.log('=== cycle-start after settle ===');
  console.log('error:', allowed?.message ?? null);

  const { data: afterAllow } = await admin
    .from('vendors')
    .select('ledger_cycle_start')
    .eq('id', vendorId)
    .single();
  console.log('ledger_cycle_start_after_settle:', afterAllow?.ledger_cycle_start);

  const pass =
    (blocked?.message ?? '').includes('ledger_cycle_change_blocked') &&
    afterBlock?.ledger_cycle_start === '2025-11-01' &&
    !limitsOk &&
    Number(afterLimits?.khata_amber_limit) === 600 &&
    Number(afterLimits?.khata_red_limit) === 1200 &&
    !allowed &&
    afterAllow?.ledger_cycle_start === allowedDate;

  console.log('=== VERDICT ===', pass ? 'PASS' : 'FAIL');

  await cleanup();
  const cleanedId = vendorId;
  vendorId = null;

  const { data: leftoverV } = await admin.from('vendors').select('id').eq('shop_name', shopName);
  const { data: leftoverPhone } = await admin.from('vendors').select('id').eq('phone', vendorPhone);
  const { data: leftoverL } = await admin
    .from('khata_ledger')
    .select('vendor_id')
    .eq('user_phone', customerPhone);
  console.log('=== leftover check ===');
  console.log(
    JSON.stringify({
      cleaned_vendor_id: cleanedId,
      vendors_by_shop: leftoverV?.length ?? 0,
      vendors_by_phone: leftoverPhone?.length ?? 0,
      ledger_by_customer: leftoverL?.length ?? 0,
    }),
  );

  if (!pass) process.exit(1);
  if ((leftoverV?.length ?? 0) + (leftoverPhone?.length ?? 0) + (leftoverL?.length ?? 0) > 0) {
    console.error('LEFTOVER DATA');
    process.exit(1);
  }
  console.log('zero leftover probe data: ok');
} catch (e) {
  console.error('PROBE ERROR', e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
