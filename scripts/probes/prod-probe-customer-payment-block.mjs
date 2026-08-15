/**
 * PROD spot-check: Section 6d customer payment block.
 * Usage: node scripts/prod-probe-customer-payment-block.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== PROD Section 6d customer payment block spot-check ===');
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
const deviceId = `prod_cpb_${T}`;
const UTR = '123456789012';

const created = { vendorIds: [], requestIds: [], billIds: [] };

async function cleanup() {
  for (const billId of created.billIds) {
    await admin.from('order_items').delete().eq('bill_id', billId);
    await admin.from('order_bills').delete().eq('id', billId);
  }
  for (const requestId of created.requestIds) {
    await admin.from('payment_dispute_events').delete().eq('request_id', requestId);
    await admin.from('requests').delete().eq('id', requestId);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', customerPhone);
}

async function getCategory(serviceMode) {
  const { data, error } = await admin
    .from('categories')
    .select('id, label')
    .eq('is_active', true)
    .eq('service_mode', serviceMode)
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

async function createVendor(tag, vendorPhone, opts = {}) {
  const serviceMode = opts.serviceMode ?? 'delivery';
  const category = await getCategory(serviceMode);
  const { data: vendor, error: vendorErr } = await admin
    .from('vendors')
    .insert({
      name: `CPB Probe ${tag}`,
      shop_name: `CPBProbe ${tag}`,
      phone: vendorPhone,
      upi_id: `${tag}@upi`,
      category: category.label,
      service_mode: serviceMode,
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

  const vcRow = {
    vendor_id: vendor.id,
    category_id: category.id,
    is_primary: true,
    status: 'approved',
    service_mode: serviceMode,
    brand_name: `CPBProbe ${tag}`,
    serves_at_vendor_place: true,
    serves_at_customer_place: serviceMode !== 'help',
  };
  if (opts.agentPrepaid) {
    vcRow.delivery_fulfillment_method = 'agent';
    vcRow.delivery_payment_timing = 'prepaid';
  }
  const { error: vcErr } = await admin.from('vendor_categories').insert(vcRow);
  if (vcErr) throw vcErr;
  return vendor.id;
}

async function seedPaidHistory(vendorId) {
  for (let i = 0; i < 3; i++) {
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
      total_amount: 100,
      payment_mode: 'upi',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    });
  }
}

async function createOrder(vendorId, message, extra = {}) {
  await admin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });
  const { data, error } = await anon.rpc('create_customer_request', {
    p_device_id: deviceId,
    p_vendor_id: vendorId,
    p_message: message,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: extra.serviceMode ?? 'help',
    p_delivery_address: extra.deliveryAddress ?? null,
    p_delivery_slot: extra.deliverySlot ?? null,
  });
  return { data, error };
}

async function seedBlockingBill(vendorId, message) {
  const { data: request, error: reqError } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  created.requestIds.push(request.id);

  const { data: billId, error: billErr } = await anon.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: 250,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: message,
    p_items: [{ name: 'Probe item', quantity: 1, unit_price: 250, unit: null }],
  });
  if (billErr) throw billErr;
  created.billIds.push(billId);

  const aged = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  await admin.from('order_bills').update({ created_at: aged }).eq('id', billId);

  return { requestId: request.id, billId };
}

async function blockStatus() {
  const { data, error } = await anon.rpc('get_customer_payment_block_status', {
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

try {
  const { data: fnCheck, error: fnErr } = await admin.rpc('get_customer_payment_block_status', {
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  if (fnErr) throw new Error(`get_customer_payment_block_status missing: ${fnErr.message}`);

  const helpVendorPhone = `99199${String(T).slice(-5)}`;
  const blockVendorPhone = `99299${String(T).slice(-5)}`;
  const targetVendorPhone = `99399${String(T).slice(-5)}`;

  const helpVendorId = await createVendor('help', helpVendorPhone, { serviceMode: 'help' });
  const blockVendorId = await createVendor('block', blockVendorPhone, { agentPrepaid: true });
  await seedPaidHistory(blockVendorId);
  const targetVendorId = await createVendor('target', targetVendorPhone, { serviceMode: 'help' });

  // 1) Ordinary order — help mode, no block
  const normal = await createOrder(helpVendorId, `prod-cpb-normal-${T}`);
  console.log('NORMAL order:', normal.error?.message ?? `OK request_id=${normal.data}`);
  if (normal.data) created.requestIds.push(normal.data);

  // 2) Blocking bill + reject
  const { requestId: blockReqId } = await seedBlockingBill(blockVendorId, `prod-cpb-block-${T}`);
  const blockedBefore = await blockStatus();
  console.log('BLOCK status before claim:', blockedBefore);

  const blocked = await createOrder(targetVendorId, `prod-cpb-blocked-attempt-${T}`);
  console.log('BLOCKED order attempt:', blocked.error?.message ?? 'UNEXPECTED OK');

  // 3) I've Paid clears block + follow-up order
  const { error: claimErr } = await anon.rpc('claim_customer_payment', {
    p_request_id: blockReqId,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: customerPhone,
  });
  console.log('Ive Paid claim:', claimErr?.message ?? 'OK');

  const blockedAfterClaim = await blockStatus();
  console.log('BLOCK status after claim:', blockedAfterClaim);

  const followUp = await createOrder(targetVendorId, `prod-cpb-followup-${T}`);
  console.log('FOLLOWUP order:', followUp.error?.message ?? `OK request_id=${followUp.data}`);
  if (followUp.data) created.requestIds.push(followUp.data);

  const result = {
    project_ref: ref,
    migration_rpc_present: !fnErr,
    normal_order_ok: !normal.error && !!normal.data,
    normal_request_id: normal.data ?? null,
    block_status_before: blockedBefore,
    blocked_is_blocked_before: blockedBefore?.is_blocked === true,
    blocked_order_rejected: /customer_payment_block/i.test(blocked.error?.message ?? ''),
    blocked_order_not_generic:
      blocked.error != null && !/customer_payment_block/i.test(blocked.error?.message ?? '') === false,
    ive_paid_claim_ok: !claimErr,
    block_status_after_claim: blockedAfterClaim,
    block_cleared_after_claim: blockedAfterClaim?.is_blocked === false,
    followup_order_ok: !followUp.error && !!followUp.data,
    followup_request_id: followUp.data ?? null,
  };

  console.log(JSON.stringify(result, null, 2));

  const ok =
    result.normal_order_ok &&
    result.blocked_is_blocked_before &&
    result.blocked_order_rejected &&
    result.ive_paid_claim_ok &&
    result.block_cleared_after_claim &&
    result.followup_order_ok;

  await cleanup();
  process.exit(ok ? 0 : 3);
} catch (e) {
  console.error(e);
  await cleanup();
  process.exit(1);
}
