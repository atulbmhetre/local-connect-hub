/**
 * PROD spot-check: Section 6a–6c payment hygiene reminders.
 * Usage: node scripts/prod-probe-payment-hygiene.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

const results = {
  schema: false,
  existingBillUsed: false,
  tier1Stamped: false,
  inboxRow: false,
  vendorRemindTwice: false,
  billId: null,
  requestId: null,
  customerPhone: null,
  vendorPhone: null,
  vendorId: null,
  message: null,
};

console.log('=== PROD payment hygiene spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const customerPhone = `88399${String(T).slice(-5)}`;
const deviceId = `prod_phr_${T}`;
const vendorPhone = `99499${String(T).slice(-5)}`;

const created = { vendorIds: [], requestIds: [], billIds: [], cleanupNotifications: [] };

async function cleanup() {
  if (created.cleanupNotifications.length) {
    await admin
      .from('user_notifications')
      .delete()
      .in('related_id', created.cleanupNotifications);
  }
  if (created.requestIds.length) {
    await admin.from('order_items').delete().in('request_id', created.requestIds);
    await admin.from('order_bills').delete().in('request_id', created.requestIds);
    await admin.from('requests').delete().in('id', created.requestIds);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', customerPhone);
}

async function assertSchema() {
  const { data, error } = await admin
    .from('order_bills')
    .select('payment_reminder_tier1_at, payment_reminder_tier2_at, last_vendor_reminder_at')
    .limit(1);
  if (error) throw error;
  results.schema = true;
  console.log('OK schema columns readable on order_bills');
}

async function findExistingEligibleBill() {
  const cutoff = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('order_bills')
    .select(
      'id, request_id, vendor_id, user_phone, created_at, payment_status, payment_reminder_tier1_at, requests!inner(status, message)',
    )
    .eq('payment_status', 'unpaid')
    .is('payment_reminder_tier1_at', null)
    .not('user_phone', 'is', null)
    .lt('created_at', cutoff)
    .not('requests.status', 'in', '("cancelled","done")')
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) {
    console.warn('findExistingEligibleBill:', error.message);
    return null;
  }
  const row = data?.[0];
  if (!row?.user_phone) return null;
  const { data: vendor } = await admin
    .from('vendors')
    .select('phone')
    .eq('id', row.vendor_id)
    .single();
  return {
    billId: row.id,
    requestId: row.request_id,
    vendorId: row.vendor_id,
    customerPhone: row.user_phone,
    vendorPhone: vendor?.phone ?? null,
    message: row.requests?.message ?? `order-${row.request_id.slice(0, 8)}`,
  };
}

async function seedAgedUnpaidBill() {
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
      name: `PHR probe ${T}`,
      shop_name: `!PHR-PROBE-${T}`,
      phone: vendorPhone,
      upi_id: `phr-${T}@upi`,
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

  await admin.from('vendor_categories').insert({
    vendor_id: vendor.id,
    category_id: category.id,
    status: 'approved',
  });

  for (let i = 0; i < 3; i++) {
    const { data: req } = await admin
      .from('requests')
      .insert({
        vendor_id: vendor.id,
        user_phone: `hist-${i}-${vendor.id.slice(0, 8)}`,
        device_id: `hist-${i}`,
        message: `hist-${i}`,
        status: 'fulfilled',
        service_mode: 'delivery',
        delivery_fulfillment_method: 'agent',
        delivery_payment_timing: 'prepaid',
      })
      .select('id')
      .single();
    if (req) {
      await admin.from('order_bills').insert({
        request_id: req.id,
        vendor_id: vendor.id,
        user_phone: `hist-${i}-${vendor.id.slice(0, 8)}`,
        total_amount: 100,
        payment_mode: 'upi',
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      });
    }
  }

  const msg = `prod-phr-${T}`;
  const { data: request, error: reqErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      device_id: deviceId,
      message: msg,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  created.requestIds.push(request.id);

  const { error: billRpcErr } = await admin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendor.id,
    p_customer_phone: customerPhone,
    p_total: 275,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PHR probe item', quantity: 1, unit_price: 275, unit: null }],
  });
  if (billRpcErr) throw new Error(`insert_bill_with_items: ${billRpcErr.message}`);

  const { data: bill } = await admin
    .from('order_bills')
    .select('id')
    .eq('request_id', request.id)
    .single();
  if (!bill) throw new Error('bill missing after insert');

  const aged = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  await admin.from('order_bills').update({ created_at: aged }).eq('id', bill.id);
  created.billIds.push(bill.id);
  created.cleanupNotifications.push(request.id);

  await admin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });

  return {
    billId: bill.id,
    requestId: request.id,
    vendorId: vendor.id,
    customerPhone,
    vendorPhone: vendor.phone,
    message: msg,
  };
}

async function main() {
  try {
    await assertSchema();

    let ctx = await findExistingEligibleBill();
    if (ctx) {
      results.existingBillUsed = true;
      console.log('Using existing unpaid bill >30m:', ctx.billId);
    } else {
      console.log('No existing eligible bill — seeding ephemeral probe bill');
      ctx = await seedAgedUnpaidBill();
    }

    results.billId = ctx.billId;
    results.requestId = ctx.requestId;
    results.customerPhone = ctx.customerPhone;
    results.vendorPhone = ctx.vendorPhone;
    results.vendorId = ctx.vendorId;
    results.message = ctx.message;

    const { data: cronResult, error: cronErr } = await admin.rpc('remind_unpaid_bills');
    if (cronErr) throw cronErr;
    console.log('remind_unpaid_bills:', cronResult);

    const { data: billAfter, error: billErr } = await admin
      .from('order_bills')
      .select('payment_reminder_tier1_at, payment_reminder_tier2_at, last_vendor_reminder_at')
      .eq('id', ctx.billId)
      .single();
    if (billErr) throw billErr;

    results.tier1Stamped = Boolean(billAfter?.payment_reminder_tier1_at);
    console.log(
      results.tier1Stamped ? 'OK payment_reminder_tier1_at stamped' : 'FAIL tier1 not stamped',
      billAfter?.payment_reminder_tier1_at,
    );

    const { data: inbox, error: inboxErr } = await admin
      .from('user_notifications')
      .select('id, type, title, body, created_at')
      .eq('user_phone', ctx.customerPhone)
      .eq('type', 'bill_payment_reminder')
      .eq('related_id', ctx.requestId)
      .order('created_at', { ascending: false })
      .limit(1);
    if (inboxErr) throw inboxErr;

    results.inboxRow = (inbox?.length ?? 0) > 0;
    console.log(
      results.inboxRow ? 'OK inbox bill_payment_reminder row' : 'FAIL no inbox row',
      inbox?.[0]?.title,
    );

    let remindOk = true;
    for (let i = 0; i < 2; i++) {
      const { error } = await anon.rpc('send_bill_payment_reminder', {
        p_bill_id: ctx.billId,
        p_source: 'vendor',
        p_vendor_id: ctx.vendorId,
        p_vendor_phone: ctx.vendorPhone,
      });
      if (error) {
        console.error(`vendor remind attempt ${i + 1} failed:`, error.message);
        remindOk = false;
      }
    }
    results.vendorRemindTwice = remindOk;
    console.log(results.vendorRemindTwice ? 'OK vendor remind x2 (no server cooldown)' : 'FAIL vendor remind');

    const { data: billFinal } = await admin
      .from('order_bills')
      .select('last_vendor_reminder_at')
      .eq('id', ctx.billId)
      .single();
    console.log('last_vendor_reminder_at:', billFinal?.last_vendor_reminder_at ?? null);

    const allOk =
      results.schema &&
      results.tier1Stamped &&
      results.inboxRow &&
      results.vendorRemindTwice;

    console.log('\n=== PROBE SUMMARY ===');
    console.log(JSON.stringify(results, null, 2));
    console.log(allOk ? '\nALL BACKEND CHECKS PASSED' : '\nSOME BACKEND CHECKS FAILED');

    if (!allOk) process.exitCode = 1;
  } finally {
    if (created.vendorIds.length || created.requestIds.length) {
      await cleanup();
      console.log('Cleaned up ephemeral probe data');
    }
  }
}

main().catch((err) => {
  console.error('PROBE CRASHED:', err);
  process.exit(1);
});
