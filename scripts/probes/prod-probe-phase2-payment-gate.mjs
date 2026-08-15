/**
 * PROD spot-check: Phase 2 payment screenshot gate + normal flow.
 * Usage: node scripts/prod-probe-phase2-payment-gate.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== PROD Phase 2 payment gate spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const customerPhone = `88199${String(T).slice(-5)}`;
const deviceId = `prod_p2_gate_${T}`;
const UTR = '123456789012';

const created = { vendorIds: [], requestIds: [], billIds: [] };

async function cleanup() {
  for (const billId of created.billIds) {
    await admin.from('order_items').delete().eq('bill_id', billId);
    await admin.from('order_bills').delete().eq('id', billId);
  }
  for (const requestId of created.requestIds) {
    await admin.from('requests').delete().eq('id', requestId);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
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
      name: `P2 Gate ${tag}`,
      shop_name: `P2Gate ${tag}`,
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
    .select('id')
    .single();
  if (vendorErr) throw vendorErr;
  created.vendorIds.push(vendor.id);

  const { error: vcErr } = await admin.from('vendor_categories').insert({
    vendor_id: vendor.id,
    category_id: category.id,
    is_primary: true,
    status: 'approved',
    service_mode: 'delivery',
    brand_name: `P2Gate ${tag}`,
    serves_at_vendor_place: true,
    serves_at_customer_place: false,
    delivery_fulfillment_method: 'agent',
    delivery_payment_timing: 'prepaid',
  });
  if (vcErr) throw vcErr;

  return vendor.id;
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
      status: 'accepted',
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

async function getRequirements(requestId) {
  const { data, error } = await anon.rpc('get_payment_claim_requirements', {
    p_request_id: requestId,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  if (error) throw error;
  return data;
}

try {
  const normalVendorPhone = `99199${String(T).slice(-5)}`;
  const anomalyVendorPhone = `99299${String(T).slice(-5)}`;

  const normalVendorId = await createAgentPrepaidVendor('normal', normalVendorPhone);
  await seedPaidBillHistory(normalVendorId, [100, 100, 100]);
  const normalReq = await seedOrder(normalVendorId, 150, `prod-p2-normal-${T}`);
  const normalReqData = await getRequirements(normalReq);
  console.log('NORMAL requirements:', normalReqData);

  const { error: normalClaimErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: normalReq,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  console.log('NORMAL claim without screenshot:', normalClaimErr?.message ?? 'OK');

  const anomalyVendorId = await createAgentPrepaidVendor('anomaly', anomalyVendorPhone);
  const anomalyReq = await seedOrder(anomalyVendorId, 500, `prod-p2-anomaly-${T}`);
  const anomalyReqData = await getRequirements(anomalyReq);
  console.log('ANOMALY requirements:', anomalyReqData);

  const { error: blockedErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: anomalyReq,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  console.log('ANOMALY claim without screenshot (expect blocked):', blockedErr?.message ?? 'UNEXPECTED OK');

  const screenshotUrl = `https://${ref}.supabase.co/storage/v1/object/public/payment-proofs/${anomalyReq}/probe.png`;
  const { error: anomalyClaimErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: anomalyReq,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
    p_payment_screenshot_url: screenshotUrl,
  });
  console.log('ANOMALY claim with screenshot URL:', anomalyClaimErr?.message ?? 'OK');

  const { data: afterAnomaly } = await admin
    .from('requests')
    .select('payment_status, payment_screenshot_url')
    .eq('id', anomalyReq)
    .single();

  const result = {
    project_ref: ref,
    normal_requires_screenshot: normalReqData?.requires_screenshot === true,
    normal_claim_ok: !normalClaimErr,
    anomaly_requires_screenshot: anomalyReqData?.requires_screenshot === true,
    anomaly_is_anomalous: anomalyReqData?.is_anomalous === true,
    anomaly_blocked_without_screenshot: /payment_screenshot_required/i.test(blockedErr?.message ?? ''),
    anomaly_claim_with_url_ok: !anomalyClaimErr,
    anomaly_payment_status: afterAnomaly?.payment_status,
    anomaly_screenshot_url: afterAnomaly?.payment_screenshot_url,
  };

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.normal_requires_screenshot === false &&
    result.normal_claim_ok &&
    result.anomaly_requires_screenshot === true &&
    result.anomaly_is_anomalous === true &&
    result.anomaly_blocked_without_screenshot &&
    result.anomaly_claim_with_url_ok &&
    result.anomaly_payment_status === 'claimed';

  await cleanup();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.error(e);
  await cleanup();
  process.exit(1);
}
