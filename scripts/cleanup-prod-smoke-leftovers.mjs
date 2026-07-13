/**
 * One-shot PROD cleanup: 8 leftover smoke vendors + their admin notifs.
 * Run: node scripts/cleanup-prod-smoke-leftovers.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const url = process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Missing PROD url/key in .env.test.prod');

const sb = createClient(url, key, { auth: { persistSession: false } });

const ALLOWED_PHONES = new Set([
  '9910429447',
  '9910422140',
  '9910309411',
  '9910300897',
  '9910292349',
  '9910285364',
  '9910178615',
  '9910171280',
]);

const { data: vendors, error: vErr } = await sb
  .from('vendors')
  .select('id,phone,name,shop_name,created_at')
  .in('phone', [...ALLOWED_PHONES])
  .order('created_at', { ascending: true });

if (vErr) throw vErr;

console.log('=== CONFIRM: vendors to delete ===');
for (const v of vendors ?? []) {
  console.log(`  ${v.created_at} phone=${v.phone} name=${v.name} shop=${v.shop_name} id=${v.id}`);
}

if ((vendors ?? []).length !== 8) {
  throw new Error(`Expected exactly 8 vendors, found ${(vendors ?? []).length}`);
}
for (const v of vendors ?? []) {
  if (!ALLOWED_PHONES.has(v.phone)) throw new Error(`Unexpected phone ${v.phone}`);
  if (!/Smoke|Multi/i.test(v.name) && !/Smoke|Multi|Home Brand/i.test(v.shop_name ?? '')) {
    throw new Error(`Unexpected name/shop for ${v.phone}: ${v.name} / ${v.shop_name}`);
  }
}

const vendorIds = (vendors ?? []).map((v) => v.id);

const { data: notifsByVendor } = await sb
  .from('user_notifications')
  .select('id,type,title,body,created_at,route_params')
  .eq('type', 'new_vendor')
  .in('route_params->>vendor_id', vendorIds);

const { data: notifsByBody } = await sb
  .from('user_notifications')
  .select('id,type,title,body,created_at,route_params')
  .eq('type', 'new_vendor')
  .or(
    'body.ilike.%Smoke Shop Owner%,body.ilike.%Smoke Home Owner%,body.ilike.%Smoke Mobile Owner%,body.ilike.%Multi Mode Owner%',
  );

const notifMap = new Map();
for (const n of [...(notifsByVendor ?? []), ...(notifsByBody ?? [])]) {
  notifMap.set(n.id, n);
}
const notifs = [...notifMap.values()];

console.log('=== CONFIRM: notifications to delete ===');
console.log(`  count=${notifs.length}`);
for (const n of notifs) {
  console.log(`  ${n.created_at} ${n.body} id=${n.id} params=${JSON.stringify(n.route_params)}`);
}

async function deleteVendorCascade(ids) {
  await sb.from('categories').update({ suggested_by_vendor_id: null }).in('suggested_by_vendor_id', ids);
  await sb.from('vendor_availability_modes').delete().in('vendor_id', ids);
  await sb.from('vendor_categories').delete().in('vendor_id', ids);
  await sb.from('vendor_verification').delete().in('vendor_id', ids);
  await sb.from('vendor_menu_items').delete().in('vendor_id', ids);
  await sb.from('saved_vendors').delete().in('vendor_id', ids);
  await sb.from('vendor_reviews').delete().in('vendor_id', ids);
  await sb.from('order_bills').delete().in('vendor_id', ids);
  await sb.from('khata_transactions').delete().in('vendor_id', ids);
  await sb.from('khata_ledger').delete().in('vendor_id', ids);
  await sb.from('user_flags').delete().in('vendor_id', ids);
  await sb.from('requests').delete().in('vendor_id', ids);
  await sb.from('feed_posts').delete().in('vendor_id', ids);
  await sb.from('referrals').delete().in('referrer_vendor_id', ids);
  await sb.from('vendor_credits').delete().in('vendor_id', ids);
  const { error } = await sb.from('vendors').delete().in('id', ids);
  if (error) throw error;
}

await deleteVendorCascade(vendorIds);
console.log(`Deleted ${vendorIds.length} vendors`);

if (notifs.length > 0) {
  const { error: nErr } = await sb
    .from('user_notifications')
    .delete()
    .in(
      'id',
      notifs.map((n) => n.id),
    );
  if (nErr) throw nErr;
  console.log(`Deleted ${notifs.length} user_notifications`);
}

const { data: remainV } = await sb.from('vendors').select('id').in('phone', [...ALLOWED_PHONES]);
const { data: remainN } = await sb
  .from('user_notifications')
  .select('id')
  .eq('type', 'new_vendor')
  .or(
    'body.ilike.%Smoke Shop Owner%,body.ilike.%Smoke Home Owner%,body.ilike.%Smoke Mobile Owner%,body.ilike.%Multi Mode Owner%',
  );
console.log('Remaining vendors with those phones:', (remainV ?? []).length);
console.log('Remaining Smoke/Multi new_vendor notifs:', (remainN ?? []).length);
console.log('DONE');
