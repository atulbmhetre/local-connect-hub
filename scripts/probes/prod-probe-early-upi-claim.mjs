/**
 * PROD spot-check: early UPI claim on accepted order + rating after fulfil.
 * Usage: node scripts/prod-probe-early-upi-claim.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== PROD early UPI claim spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const vendorPhone = `99098${String(T).slice(-5)}`;
const customerPhone = `88098${String(T).slice(-5)}`;
const deviceId = `prod_early_upi_${T}`;
const UTR = '987654321098';

let vendorId = null;
let requestId = null;
let billId = null;

async function cleanup() {
  if (billId) {
    await admin.from('order_items').delete().eq('bill_id', billId);
    await admin.from('order_bills').delete().eq('id', billId);
  }
  if (requestId) {
    await admin.from('vendor_reviews').delete().eq('request_id', requestId);
    await admin.from('requests').delete().eq('id', requestId);
  }
  if (vendorId) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', vendorPhone);
  await admin.from('users').delete().eq('phone', customerPhone);
}

try {
  const { data: cat } = await admin.from('categories').select('id, label').eq('is_active', true).limit(1).single();
  if (!cat) throw new Error('no category');

  const { data: regVendorId, error: regErr } = await anon.rpc('register_vendor', {
    p_name: `Early UPI Probe ${T}`,
    p_shop_name: `EarlyUPIProbe ${T}`,
    p_category: cat.label,
    p_phone: vendorPhone,
    p_upi_id: 'earlyupiprobe@upi',
    p_service_mode: 'delivery',
    p_vendor_type: 'shop',
    p_vendor_note: `prod_early_upi:${T}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `EU${String(T).slice(-5)}`,
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: ['delivery'],
    p_category_modes: { [cat.id]: ['delivery'] },
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 15,
    p_availability_modes: ['delivery'],
  });
  if (regErr) throw regErr;
  vendorId = regVendorId;

  await admin.from('users').upsert({ phone: customerPhone, trust_score: 70 }, { onConflict: 'phone' });

  const { data: req, error: reqErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message: `prod-early-upi-${T}`,
      status: 'accepted',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  requestId = req.id;

  const { data: insertedBillId, error: billErr } = await anon.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: 250,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: 'PROD early UPI probe',
    p_items: [{ name: 'Probe item', quantity: 1, unit_price: 250, unit: null }],
  });
  if (billErr) throw billErr;
  billId = insertedBillId;

  const { error: claimErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  if (claimErr) throw claimErr;

  const { data: afterClaim } = await admin
    .from('requests')
    .select('status, payment_status, payment_utr')
    .eq('id', requestId)
    .single();

  const { error: preReviewErr } = await anon.rpc('submit_vendor_review', {
    p_vendor_id: vendorId,
    p_request_id: requestId,
    p_user_phone: customerPhone,
    p_device_id: deviceId,
    p_rating: 5,
    p_review_text: 'should fail pre-fulfil',
    p_service_mode: 'delivery',
  });

  const { error: fulfilErr } = await admin.rpc('vendor_fulfil_order', {
    p_request_id: requestId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
  });
  if (fulfilErr) throw fulfilErr;

  const { data: afterFulfil } = await admin
    .from('requests')
    .select('status, payment_status')
    .eq('id', requestId)
    .single();

  const { error: reviewErr } = await anon.rpc('submit_vendor_review', {
    p_vendor_id: vendorId,
    p_request_id: requestId,
    p_user_phone: customerPhone,
    p_device_id: deviceId,
    p_rating: 4,
    p_review_text: 'PROD probe rating',
    p_service_mode: 'delivery',
  });

  const fnCheck = await admin.rpc('notification_i18n_format', {
    p_copy_key: 'bill_sent',
    p_user_phone: customerPhone,
    p_replacements: { shop_name: 'x', amount: '1', payment_mode: 'UPI' },
  });
  void fnCheck;

  const result = {
    project_ref: ref,
    request_id: requestId,
    bill_id: billId,
    after_claim: afterClaim,
    claim_on_accepted_ok: afterClaim?.status === 'accepted' && afterClaim?.payment_status === 'claimed',
    pre_fulfil_review_blocked: !!preReviewErr && /order_not_fulfilled/i.test(preReviewErr.message),
    after_fulfil: afterFulfil,
    fulfil_ok: afterFulfil?.status === 'fulfilled',
    payment_preserved_after_fulfil: afterFulfil?.payment_status === 'claimed',
    post_fulfil_review_ok: !reviewErr,
    rating_gate_message: reviewErr?.message ?? null,
  };

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.claim_on_accepted_ok &&
    result.pre_fulfil_review_blocked &&
    result.fulfil_ok &&
    result.payment_preserved_after_fulfil &&
    result.post_fulfil_review_ok;

  await cleanup();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.error(e);
  await cleanup();
  process.exit(1);
}
