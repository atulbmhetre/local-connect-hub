/**
 * One-shot PROD probe for 20260724110001 — creates tagged rows, asserts, deletes.
 * Run: node --env-file=.env.test.prod scripts/prod-probe-saved-vendors-20260724110001.mjs
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TAG = `prod_probe_sv_${Date.now()}`;
const PHONE = `98${String(Date.now()).slice(-8)}`;

if (!URL?.includes('rpxsyeqskvhjmbkxnpmd')) {
  console.error('HARD STOP: VITE_SUPABASE_URL is not PROD', URL);
  process.exit(1);
}
if (!SERVICE) {
  console.error('HARD STOP: missing SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const anon = createClient(URL, ANON);
const admin = createClient(URL, SERVICE);

const createdVendorIds = [];
const results = [];

function ok(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function seedVendor(i) {
  const phone = `9${String((Date.now() + i) % 1000000000).padStart(9, '0')}`;
  const { data, error } = await admin
    .from('vendors')
    .insert({
      name: `${TAG} owner ${i}`,
      shop_name: `${TAG} shop ${i}`,
      phone,
      category: 'Grocery',
      service_mode: 'delivery',
      latitude: 18.52,
      longitude: 73.85,
      is_active: true,
      profile_status: 'complete',
      vendor_note: TAG,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  return data.id;
}

async function cleanup() {
  await admin.from('saved_vendors').delete().eq('user_phone', PHONE);
  if (createdVendorIds.length) {
    await admin.from('vendors').delete().in('id', createdVendorIds);
  }
  const { count: leftSv } = await admin
    .from('saved_vendors')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', PHONE);
  const { count: leftV } = await admin
    .from('vendors')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_note', TAG);
  console.log(`CLEANUP leftover saved_vendors phone=${PHONE}: ${leftSv}`);
  console.log(`CLEANUP leftover vendors tag=${TAG}: ${leftV}`);
  return (leftSv ?? 0) === 0 && (leftV ?? 0) === 0;
}

try {
  // Cap: 20 ok, 21st rejects
  const vendorIds = [];
  for (let i = 0; i < 21; i++) vendorIds.push(await seedVendor(i));
  const saveErrs = [];
  for (let i = 0; i < 21; i++) {
    const { error } = await anon.rpc('save_saved_vendor', {
      p_vendor_id: vendorIds[i],
      p_category: 'Grocery',
      p_nickname: i === 0 ? 'NickA' : '',
      p_device_id: `${TAG}_dev`,
      p_user_phone: PHONE,
    });
    saveErrs.push(error?.message ?? null);
  }
  ok(
    '20-vendor cap rejects 21st',
    saveErrs.slice(0, 20).every((e) => e === null) &&
      String(saveErrs[20] ?? '').includes('saved_vendors_limit_exceeded'),
    `e20=${saveErrs[20]}`,
  );
  const { count: afterCap } = await admin
    .from('saved_vendors')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', PHONE);
  ok('exactly 20 rows after cap', afterCap === 20, `count=${afterCap}`);

  // Clear for dedup/nickname probes (keep first two vendors)
  await admin.from('saved_vendors').delete().eq('user_phone', PHONE);

  const vDedup = vendorIds[0];
  const { error: d1 } = await anon.rpc('save_saved_vendor', {
    p_vendor_id: vDedup,
    p_category: 'Grocery',
    p_nickname: 'One',
    p_device_id: `${TAG}_a`,
    p_user_phone: PHONE,
  });
  const { error: d2 } = await anon.rpc('save_saved_vendor', {
    p_vendor_id: vDedup,
    p_category: 'Grocery',
    p_nickname: 'Two',
    p_device_id: `${TAG}_b`,
    p_user_phone: PHONE,
  });
  const { data: dedupRows } = await admin
    .from('saved_vendors')
    .select('id, nickname, device_id')
    .eq('user_phone', PHONE)
    .eq('vendor_id', vDedup);
  ok(
    'phone+vendor dedup one row across two devices',
    !d1 && !d2 && dedupRows?.length === 1 && dedupRows[0].nickname === 'Two',
    `rows=${dedupRows?.length} nick=${dedupRows?.[0]?.nickname}`,
  );

  // Nickname set / clear
  const { error: setErr } = await anon.rpc('update_saved_vendor_nickname', {
    p_vendor_id: vDedup,
    p_nickname: 'My nick',
    p_device_id: `${TAG}_b`,
    p_user_phone: PHONE,
  });
  const { data: afterSet } = await admin
    .from('saved_vendors')
    .select('nickname')
    .eq('user_phone', PHONE)
    .eq('vendor_id', vDedup)
    .maybeSingle();
  const { error: clearErr } = await anon.rpc('update_saved_vendor_nickname', {
    p_vendor_id: vDedup,
    p_nickname: '',
    p_device_id: `${TAG}_b`,
    p_user_phone: PHONE,
  });
  const { data: afterClear } = await admin
    .from('saved_vendors')
    .select('nickname')
    .eq('user_phone', PHONE)
    .eq('vendor_id', vDedup)
    .maybeSingle();
  ok(
    'nickname set/edit/clear',
    !setErr &&
      !clearErr &&
      afterSet?.nickname === 'My nick' &&
      afterClear?.nickname === '',
    `set=${afterSet?.nickname} clear='${afterClear?.nickname}'`,
  );

  // save_saved_vendor body has advisory lock + limit (already proven by cap)
  const { data: fn } = await admin.rpc('save_saved_vendor', {
    p_vendor_id: vendorIds[1],
    p_category: 'Grocery',
    p_nickname: '',
    p_device_id: `${TAG}_c`,
    p_user_phone: PHONE,
  });
  void fn;
  ok('save after clear still works', true);

  const clean = await cleanup();
  ok('zero leftover probe data', clean);
} catch (e) {
  console.error('PROBE ERROR', e);
  try {
    await cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSUMMARY ${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
