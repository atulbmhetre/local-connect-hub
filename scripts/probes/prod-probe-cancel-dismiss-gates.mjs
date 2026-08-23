/**
 * PROD spot-check: post-accept cancel gates + dismiss unpaid cash/UPI block.
 * Usage: node scripts/probes/prod-probe-cancel-dismiss-gates.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== PROD cancel + dismiss gate spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}
if (!serviceKey || !anonKey) {
  console.error('ABORT: missing keys');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const customerPhone = `88176${String(T).slice(-5)}`;
const helpVendorPhone = `99176${String(T).slice(-5)}`;
const deliveryVendorPhone = `99276${String(T).slice(-5)}`;
const deviceId = `prod_cdg_${T}`;

const created = {
  vendorIds: [],
  requestIds: [],
  billIds: [],
  phones: [customerPhone, helpVendorPhone, deliveryVendorPhone],
};

const result = {
  project_ref: ref,
  help_cancel_before_started: null,
  asap_cancel_blocked: null,
  dismiss_blocked_unpaid: null,
  dismiss_ok_after_paid: null,
  errors: [],
};

async function cleanup() {
  if (created.billIds.length) {
    await admin.from('order_items').delete().in('bill_id', created.billIds);
    await admin.from('order_bills').delete().in('id', created.billIds);
  }
  if (created.requestIds.length) {
    await admin.from('order_bills').delete().in('request_id', created.requestIds);
    await admin.from('requests').delete().in('id', created.requestIds);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  for (const phone of created.phones) {
    await admin.from('users').delete().eq('phone', phone);
  }
}

async function categoryForMode(mode) {
  const { data: rows, error } = await admin
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .limit(80);
  if (error) throw error;
  const hit =
    rows?.find((c) => String(c.service_mode ?? '').toLowerCase() === mode) ??
    rows?.find((c) => String(c.service_mode ?? '').toLowerCase().includes(mode)) ??
    rows?.[0];
  if (!hit) throw new Error(`no category for mode=${mode}`);
  return hit;
}

async function registerVendor(phone, mode, labelPrefix) {
  const cat = await categoryForMode(mode);
  const { data: vendorId, error } = await anon.rpc('register_vendor', {
    p_name: `${labelPrefix} ${T}`,
    p_shop_name: `${labelPrefix}Shop ${T}`,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: `${labelPrefix.toLowerCase()}${String(T).slice(-4)}@upi`,
    p_service_mode: mode,
    p_vendor_type: 'shop',
    p_vendor_note: `prod_cdg:${T}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `${labelPrefix.slice(0, 2).toUpperCase()}${String(T).slice(-6)}`.slice(0, 8),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [mode],
    p_category_modes: { [cat.id]: [mode] },
    p_base_type: 'shop',
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: true,
    p_service_radius_km: 15,
    p_availability_modes: [mode],
  });
  if (error) throw error;
  created.vendorIds.push(vendorId);
  return vendorId;
}

try {
  await admin.from('users').upsert({ phone: customerPhone, trust_score: 70 }, { onConflict: 'phone' });

  // 1) Help accepted, before I've Started → cancel succeeds
  const helpVendorId = await registerVendor(helpVendorPhone, 'help', 'HelpCancel');
  const { data: helpReq, error: helpInsErr } = await admin
    .from('requests')
    .insert({
      vendor_id: helpVendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message: `prod-help-cancel-${T}`,
      status: 'accepted',
      service_mode: 'help',
      vendor_started_at: null,
      category_id: (await categoryForMode('help')).id,
    })
    .select('id, status, vendor_started_at')
    .single();
  if (helpInsErr) throw helpInsErr;
  created.requestIds.push(helpReq.id);

  const { error: helpCancelErr } = await anon.rpc('cancel_customer_order', {
    p_request_id: helpReq.id,
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  const { data: helpAfter } = await admin
    .from('requests')
    .select('status')
    .eq('id', helpReq.id)
    .single();
  result.help_cancel_before_started = {
    ok: !helpCancelErr && helpAfter?.status === 'cancelled',
    error: helpCancelErr?.message ?? null,
    status: helpAfter?.status ?? null,
  };

  // 2) ASAP delivery accepted → cancel blocked immediately
  const deliveryVendorId = await registerVendor(deliveryVendorPhone, 'delivery', 'AsapCancel');
  const { data: asapReq, error: asapInsErr } = await admin
    .from('requests')
    .insert({
      vendor_id: deliveryVendorId,
      user_phone: customerPhone,
      device_id: `${deviceId}_asap`,
      message: `prod-asap-cancel-${T}`,
      status: 'accepted',
      service_mode: 'delivery',
      delivery_slot: 'asap',
      delivery_slot_deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      delivery_address: 'PROD probe address',
      vendor_started_at: null,
      category_id: (await categoryForMode('delivery')).id,
    })
    .select('id, status, delivery_slot')
    .single();
  if (asapInsErr) throw asapInsErr;
  created.requestIds.push(asapReq.id);

  const { error: asapCancelErr } = await anon.rpc('cancel_customer_order', {
    p_request_id: asapReq.id,
    p_user_phone: customerPhone,
    p_device_id: `${deviceId}_asap`,
  });
  const { data: asapAfter } = await admin
    .from('requests')
    .select('status')
    .eq('id', asapReq.id)
    .single();
  result.asap_cancel_blocked = {
    ok:
      !!asapCancelErr &&
      /cancel_blocked_asap_accepted/i.test(asapCancelErr.message) &&
      asapAfter?.status === 'accepted',
    error: asapCancelErr?.message ?? null,
    status: asapAfter?.status ?? null,
  };

  // 3) Dismiss blocked on unpaid cash, unblocks after paid
  const { data: dismissReq, error: dismissInsErr } = await admin
    .from('requests')
    .insert({
      vendor_id: deliveryVendorId,
      user_phone: customerPhone,
      device_id: `${deviceId}_dismiss`,
      message: `prod-dismiss-unpaid-${T}`,
      status: 'fulfilled',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      category_id: (await categoryForMode('delivery')).id,
    })
    .select('id')
    .single();
  if (dismissInsErr) throw dismissInsErr;
  created.requestIds.push(dismissReq.id);

  const { data: bill, error: billErr } = await admin
    .from('order_bills')
    .insert({
      request_id: dismissReq.id,
      vendor_id: deliveryVendorId,
      user_phone: customerPhone,
      total_amount: 175,
      payment_mode: 'cash',
      payment_status: 'unpaid',
    })
    .select('id, payment_status, payment_mode')
    .single();
  if (billErr) throw billErr;
  created.billIds.push(bill.id);

  const { error: unpaidDismissErr } = await anon.rpc('dismiss_order', {
    p_request_id: dismissReq.id,
    p_user_phone: customerPhone,
    p_device_id: `${deviceId}_dismiss`,
    p_appointment_status: null,
  });
  const { data: unpaidAfter } = await admin
    .from('requests')
    .select('status')
    .eq('id', dismissReq.id)
    .single();
  result.dismiss_blocked_unpaid = {
    ok:
      !!unpaidDismissErr &&
      /dismiss_blocked_unpaid_bill/i.test(unpaidDismissErr.message) &&
      unpaidAfter?.status === 'fulfilled',
    error: unpaidDismissErr?.message ?? null,
    status: unpaidAfter?.status ?? null,
  };

  const { error: markPaidErr } = await admin
    .from('order_bills')
    .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', bill.id);
  if (markPaidErr) throw markPaidErr;

  const { error: paidDismissErr } = await anon.rpc('dismiss_order', {
    p_request_id: dismissReq.id,
    p_user_phone: customerPhone,
    p_device_id: `${deviceId}_dismiss`,
    p_appointment_status: null,
  });
  const { data: paidAfter } = await admin
    .from('requests')
    .select('status')
    .eq('id', dismissReq.id)
    .single();
  result.dismiss_ok_after_paid = {
    ok: !paidDismissErr && paidAfter?.status === 'done',
    error: paidDismissErr?.message ?? null,
    status: paidAfter?.status ?? null,
  };

  const allOk =
    result.help_cancel_before_started?.ok &&
    result.asap_cancel_blocked?.ok &&
    result.dismiss_blocked_unpaid?.ok &&
    result.dismiss_ok_after_paid?.ok;

  console.log(JSON.stringify(result, null, 2));
  console.log(allOk ? 'PASS' : 'FAIL');
  await cleanup();
  process.exit(allOk ? 0 : 1);
} catch (err) {
  result.errors.push(String(err?.message ?? err));
  console.error('SPOT-CHECK ERROR:', err);
  console.log(JSON.stringify(result, null, 2));
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error('cleanup failed:', cleanupErr);
  }
  process.exit(1);
}
