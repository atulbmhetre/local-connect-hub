/**
 * PROD spot-check: Section 5c payment dispute backstop.
 * Usage: node scripts/prod-probe-dispute-backstop.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

const CASH_ONLY_COPY =
  'Online payment is temporarily unavailable on your account. Please pay cash to the vendor.';

console.log('=== PROD dispute backstop spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const customerPhone = `88299${String(T).slice(-5)}`;
const deviceId = `prod_pdb_${T}`;
const UTR = '123456789012';

const created = { vendorIds: [], requestIds: [], billIds: [] };

async function cleanup() {
  if (created.requestIds.length) {
    await admin.from('payment_dispute_events').delete().in('request_id', created.requestIds);
    await admin.from('order_items').delete().in('request_id', created.requestIds);
    await admin.from('order_bills').delete().in('request_id', created.requestIds);
    await admin.from('requests').delete().in('id', created.requestIds);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('customer_payment_restrictions').delete().eq('identity_key', customerPhone);
  await admin.from('users').delete().eq('phone', customerPhone);
}

async function createAgentPrepaidVendor(tag, vendorPhone) {
  const { data: category, error: catErr } = await admin
    .from('categories')
    .select('id, label')
    .eq('is_active', true)
    .eq('service_mode', 'delivery')
    .limit(1)
    .single();
  if (catErr) throw catErr;

  const { data: vendor, error: vendorErr } = await admin
    .from('vendors')
    .insert({
      name: `PDB ${tag}`,
      shop_name: `PDB ${tag}`,
      phone: vendorPhone,
      upi_id: `${tag}@upi`,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone')
    .single();
  if (vendorErr) throw vendorErr;
  created.vendorIds.push(vendor.id);

  const { error: vcErr } = await admin.from('vendor_categories').insert({
    vendor_id: vendor.id,
    category_id: category.id,
    is_primary: true,
    status: 'approved',
    service_mode: 'delivery',
    brand_name: `PDB ${tag}`,
    serves_at_vendor_place: true,
    serves_at_customer_place: false,
    delivery_fulfillment_method: 'agent',
    delivery_payment_timing: 'prepaid',
  });
  if (vcErr) throw vcErr;

  return vendor;
}

async function seedPaidBillHistory(vendorId, amounts) {
  for (let i = 0; i < amounts.length; i++) {
    const histPhone = `hist_${i}_${T}`;
    const { data: req, error } = await admin
      .from('requests')
      .insert({
        vendor_id: vendorId,
        user_phone: histPhone,
        device_id: `hist_${i}_${deviceId}`,
        message: `hist-${i}`,
        status: 'fulfilled',
        service_mode: 'delivery',
        delivery_fulfillment_method: 'agent',
        delivery_payment_timing: 'prepaid',
      })
      .select('id')
      .single();
    if (error) throw error;
    created.requestIds.push(req.id);
    await admin.from('order_bills').insert({
      request_id: req.id,
      vendor_id: vendorId,
      user_phone: histPhone,
      total_amount: amounts[i],
      payment_mode: 'upi',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    });
  }
}

async function seedOrder(vendorId, amount, msg) {
  await admin.from('users').upsert({ phone: customerPhone, trust_score: 70 }, { onConflict: 'phone' });

  const { data: req, error: reqErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message: msg,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  created.requestIds.push(req.id);

  const { data: billId, error: billErr } = await anon.rpc('insert_bill_with_items', {
    p_order_id: req.id,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: amount,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: msg,
    p_items: [{ name: 'Item', quantity: 1, unit_price: amount, unit: null }],
  });
  if (billErr) throw billErr;
  created.billIds.push(billId);
  return req.id;
}

async function claimAndDispute(requestId, vendorPhone) {
  const { error: claimErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const { error: disputeErr } = await anon.rpc('dispute_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendorPhone,
  });
  if (disputeErr) throw new Error(`dispute failed: ${disputeErr.message}`);
}

async function restrictionStatus() {
  const { data, error } = await anon.rpc('get_customer_payment_restriction_status', {
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  if (error) throw error;
  return Boolean(data?.[0]?.is_restricted);
}

function wouldShowPayNow(order, bill, restricted) {
  if (restricted) return false;
  if (bill.payment_status !== 'unpaid' || bill.payment_mode !== 'upi') return false;
  if (order.service_mode !== 'delivery') return false;
  if (order.delivery_fulfillment_method !== 'agent') return false;
  if (order.delivery_payment_timing !== 'prepaid') return false;
  return true;
}

function wouldShowCashOnlyCopy(order, bill, restricted) {
  if (!restricted) return false;
  return wouldShowPayNow(order, bill, false);
}

try {
  const vendorAPhone = `99399${String(T).slice(-5)}`;
  const vendorBPhone = `99499${String(T).slice(-5)}`;

  const vendorA = await createAgentPrepaidVendor('a', vendorAPhone);
  const vendorB = await createAgentPrepaidVendor('b', vendorBPhone);
  await seedPaidBillHistory(vendorA.id, [100, 100, 100]);
  await seedPaidBillHistory(vendorB.id, [100, 100, 100]);

  const reqA = await seedOrder(vendorA.id, 150, `prod-pdb-a-${T}`);
  const reqB = await seedOrder(vendorB.id, 150, `prod-pdb-b-${T}`);

  await claimAndDispute(reqA, vendorA.phone);
  const afterOne = await restrictionStatus();
  console.log('After 1st vendor dispute — restricted:', afterOne);

  await claimAndDispute(reqB, vendorB.phone);
  const afterTwo = await restrictionStatus();
  console.log('After 2nd vendor dispute — restricted:', afterTwo);

  const { data: restrictionRow } = await admin
    .from('customer_payment_restrictions')
    .select('is_restricted, restricted_at, last_dispute_at')
    .eq('identity_key', customerPhone)
    .single();

  const { error: claimBlockedErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: reqA,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  console.log(
    'claim_customer_payment while restricted:',
    claimBlockedErr?.message ?? 'UNEXPECTED OK',
  );

  const orderShape = {
    service_mode: 'delivery',
    delivery_fulfillment_method: 'agent',
    delivery_payment_timing: 'prepaid',
  };
  const billShape = { payment_mode: 'upi', payment_status: 'unpaid' };
  const uiPayNowVisible = wouldShowPayNow(orderShape, billShape, afterTwo);
  const uiCashOnlyVisible = wouldShowCashOnlyCopy(orderShape, billShape, afterTwo);

  const result = {
    project_ref: ref,
    after_one_vendor_restricted: afterOne,
    after_two_vendors_restricted: afterTwo,
    db_is_restricted: restrictionRow?.is_restricted === true,
    db_has_restricted_at: Boolean(restrictionRow?.restricted_at),
    claim_rejects: /payment_self_declare_restricted/i.test(claimBlockedErr?.message ?? ''),
    ui_pay_now_hidden: uiPayNowVisible === false,
    ui_cash_only_copy_would_show: uiCashOnlyVisible,
    ui_cash_only_copy: CASH_ONLY_COPY,
    dispute_event_count: (
      await admin
        .from('payment_dispute_events')
        .select('id', { count: 'exact', head: true })
        .eq('user_phone', customerPhone)
    ).count,
  };

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.after_one_vendor_restricted === false &&
    result.after_two_vendors_restricted === true &&
    result.db_is_restricted === true &&
    result.claim_rejects === true &&
    result.ui_pay_now_hidden === true &&
    result.ui_cash_only_copy_would_show === true &&
    (result.dispute_event_count ?? 0) >= 2;

  await cleanup();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.error(e);
  await cleanup();
  process.exit(1);
}
