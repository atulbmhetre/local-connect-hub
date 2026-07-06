/**
 * One-off TEST DB verification for vendor_edit_bill — run: node scripts/bill-edit-rpc-test.mjs
 * Output saved to bill-edit-rpc-test-results.json
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test');
  process.exit(1);
}

const db = createClient(url, serviceKey);
const SESSION = `bedit_${Date.now()}`;
const results = { session: SESSION, scenarios: {}, test2: null };

function errMsg(error) {
  return error?.message ?? String(error);
}

function isExpectedError(error, code) {
  return errMsg(error).includes(code);
}

async function getFirstCategory() {
  const { data, error } = await db.from('categories').select('id, label, service_mode').eq('is_active', true).limit(1).single();
  if (error) throw error;
  return data;
}

async function ensureVendor() {
  const phone = `9${String(Date.now()).slice(-9)}`;
  const cat = await getFirstCategory();
  const { data: vendorId, error } = await db.rpc('register_vendor', {
    p_name: `BillEdit Test ${SESSION}`,
    p_shop_name: `BillEdit Shop ${SESSION}`,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: 'billedit@upi',
    p_service_mode: cat.service_mode,
    p_vendor_type: 'shop',
    p_vendor_note: SESSION,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `B${Date.now().toString(36).slice(-5)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [cat.service_mode],
  });
  if (error) throw error;
  return { vendorId, vendorPhone: phone };
}

function customerPhone(suffix) {
  return `8800${String(Date.now() + suffix).slice(-6)}${suffix}`;
}

async function seedRequest(vendorId, userPhone) {
  const { data, error } = await db
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `Bill edit test ${SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function insertBill({ requestId, vendorId, customerPhone, total, paymentMode, paymentStatus = 'unpaid', items }) {
  const { data: billId, error } = await db.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: total,
    p_payment_mode: paymentMode,
    p_payment_status: paymentStatus,
    p_notes: null,
    p_items: items ?? [{ name: 'Item A', quantity: 1, unit_price: total, unit: null }],
  });
  if (error) throw error;
  return billId;
}

async function fetchBillState(billId, requestId) {
  const [{ data: bill }, { data: items }, { data: audits }, { data: khataTx }] = await Promise.all([
    db.from('order_bills').select('*').eq('id', billId).single(),
    db.from('order_items').select('*').eq('request_id', requestId).order('created_at'),
    db.from('bill_edit_audit').select('*').eq('bill_id', billId).order('edited_at'),
    db.from('khata_transactions').select('*').eq('request_id', requestId).order('created_at'),
  ]);
  return { bill, items, audits, khata_transactions: khataTx };
}

async function fetchLedger(vendorId, userPhone) {
  const { data } = await db
    .from('khata_ledger')
    .select('*')
    .eq('vendor_id', vendorId)
    .eq('user_phone', userPhone)
    .maybeSingle();
  return data;
}

async function cleanup(ids) {
  const { requestIds, vendorId, customerPhones } = ids;
  for (const rid of requestIds) {
    await db.from('bill_edit_audit').delete().in('bill_id', (await db.from('order_bills').select('id').eq('request_id', rid)).data?.map((b) => b.id) ?? []);
    await db.from('order_items').delete().eq('request_id', rid);
    await db.from('order_bills').delete().eq('request_id', rid);
    await db.from('khata_transactions').delete().eq('request_id', rid);
    await db.from('requests').delete().eq('id', rid);
  }
  for (const phone of customerPhones) {
    await db.from('khata_transactions').delete().eq('user_phone', phone);
    await db.from('khata_ledger').delete().eq('user_phone', phone);
  }
  if (vendorId) {
    await db.from('vendors').delete().eq('id', vendorId);
  }
}

async function runTest2(vendorId, vendorPhone) {
  const phone = customerPhone(1);
  const requestId = await seedRequest(vendorId, phone);
  const billId = await insertBill({
    requestId,
    vendorId,
    customerPhone: phone,
    total: 100,
    paymentMode: 'khata',
    items: [{ name: 'Khata item', quantity: 1, unit_price: 100, unit: null }],
  });

  const ledgerBeforePayment = await fetchLedger(vendorId, phone);

  const { data: outstandingAfterPayment, error: payErr } = await db.rpc('vendor_record_khata_payment', {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_customer_phone: phone,
    p_amount: 80,
    p_note: 'Partial payment for negative test',
  });
  if (payErr) throw payErr;

  const ledgerBeforeEdit = await fetchLedger(vendorId, phone);

  const { data: editResult, error: editErr } = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Reduced item', quantity: 1, unit_price: 10, unit: null }],
    p_reason: 'Over-correction test',
    p_confirmed_late_edit: false,
  });

  const ledgerAfterEdit = await fetchLedger(vendorId, phone);
  const khataTx = (await db.from('khata_transactions').select('*').eq('request_id', requestId).order('created_at')).data;

  results.test2 = {
    billId,
    requestId,
    customerPhone: phone,
    ledgerBeforePayment,
    outstandingAfterPayment,
    ledgerBeforeEdit,
    editError: editErr ? errMsg(editErr) : null,
    editResult,
    ledgerAfterEdit,
    khataTransactions: khataTx,
    math: {
      expectedDelta: 10 - 100,
      expectedOutstandingIfUnclamped: (ledgerBeforeEdit?.total_outstanding ?? 0) + (10 - 100),
    },
  };

  return { requestId, phone };
}

async function scenarioA(vendorId, vendorPhone) {
  const phone = customerPhone(2);
  const requestId = await seedRequest(vendorId, phone);
  const billId = await insertBill({
    requestId,
    vendorId,
    customerPhone: phone,
    total: 200,
    paymentMode: 'cash',
    items: [{ name: 'Cash item', quantity: 1, unit_price: 200, unit: null }],
  });

  const { data, error } = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [
      { name: 'Cash item revised', quantity: 2, unit_price: 75, unit: 'kg' },
      { name: 'Extra', quantity: 1, unit_price: 50, unit: null },
    ],
    p_reason: null,
    p_confirmed_late_edit: false,
  });

  results.scenarios.a = {
    label: 'Fresh unpaid non-khata, no reason',
    rpcError: error ? errMsg(error) : null,
    rpcResult: data,
    state: await fetchBillState(billId, requestId),
  };
  return { requestId, phone };
}

async function scenarioB(vendorId, vendorPhone) {
  const phone = customerPhone(3);
  const requestId = await seedRequest(vendorId, phone);
  const billId = await insertBill({
    requestId,
    vendorId,
    customerPhone: phone,
    total: 300,
    paymentMode: 'cash',
    items: [{ name: 'Paid item', quantity: 1, unit_price: 300, unit: null }],
  });

  await db.rpc('vendor_mark_bill_paid', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
  });

  const fail = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Paid item revised', quantity: 1, unit_price: 250, unit: null }],
    p_reason: null,
    p_confirmed_late_edit: false,
  });

  const success = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Paid item revised', quantity: 1, unit_price: 250, unit: null }],
    p_reason: 'Price correction after payment',
    p_confirmed_late_edit: false,
  });

  results.scenarios.b = {
    label: 'Paid non-khata',
    withoutReason: {
      error: fail.error ? errMsg(fail.error) : null,
      data: fail.data,
    },
    withReason: {
      error: success.error ? errMsg(success.error) : null,
      data: success.data,
    },
    state: await fetchBillState(billId, requestId),
    khataTransactionCount: (await db.from('khata_transactions').select('id', { count: 'exact', head: true }).eq('request_id', requestId)).count,
  };
  return { requestId, phone };
}

async function scenarioC(vendorId, vendorPhone) {
  const phone = customerPhone(4);
  const requestId = await seedRequest(vendorId, phone);
  const billId = await insertBill({
    requestId,
    vendorId,
    customerPhone: phone,
    total: 150,
    paymentMode: 'khata',
    items: [{ name: 'Khata fresh', quantity: 1, unit_price: 150, unit: null }],
  });

  const { data, error } = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Khata fresh revised', quantity: 1, unit_price: 175, unit: null }],
    p_reason: 'Added missing item charge',
    p_confirmed_late_edit: false,
  });

  results.scenarios.c = {
    label: 'Khata bill <24h with reason, no late confirm',
    rpcError: error ? errMsg(error) : null,
    rpcResult: data,
    state: await fetchBillState(billId, requestId),
    ledger: await fetchLedger(vendorId, phone),
  };
  return { requestId, phone };
}

async function scenarioD(vendorId, vendorPhone) {
  const phone = customerPhone(5);
  const requestId = await seedRequest(vendorId, phone);
  const billId = await insertBill({
    requestId,
    vendorId,
    customerPhone: phone,
    total: 400,
    paymentMode: 'khata',
    items: [{ name: 'Khata old', quantity: 1, unit_price: 400, unit: null }],
  });

  const backdate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  await db.from('order_bills').update({ created_at: backdate }).eq('id', billId);

  const fail = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Khata old revised', quantity: 1, unit_price: 350, unit: null }],
    p_reason: 'Late correction',
    p_confirmed_late_edit: false,
  });

  const success = await db.rpc('vendor_edit_bill', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_new_items: [{ name: 'Khata old revised', quantity: 1, unit_price: 350, unit: null }],
    p_reason: 'Late correction',
    p_confirmed_late_edit: true,
  });

  const { data: billRow } = await db.from('order_bills').select('created_at').eq('id', billId).single();

  results.scenarios.d = {
    label: 'Khata bill backdated 48h',
    backdatedCreatedAt: billRow?.created_at,
    withoutLateConfirm: {
      error: fail.error ? errMsg(fail.error) : null,
      data: fail.data,
    },
    withLateConfirm: {
      error: success.error ? errMsg(success.error) : null,
      data: success.data,
    },
    state: await fetchBillState(billId, requestId),
    ledger: await fetchLedger(vendorId, phone),
  };
  return { requestId, phone };
}

async function main() {
  const { vendorId, vendorPhone } = await ensureVendor();
  results.vendor = { vendorId, vendorPhone };

  const requestIds = [];
  const customerPhones = [];

  try {
    const t2 = await runTest2(vendorId, vendorPhone);
    requestIds.push(t2.requestId);
    customerPhones.push(t2.phone);

    const a = await scenarioA(vendorId, vendorPhone);
    requestIds.push(a.requestId);
    customerPhones.push(a.phone);

    const b = await scenarioB(vendorId, vendorPhone);
    requestIds.push(b.requestId);
    customerPhones.push(b.phone);

    const c = await scenarioC(vendorId, vendorPhone);
    requestIds.push(c.requestId);
    customerPhones.push(c.phone);

    const d = await scenarioD(vendorId, vendorPhone);
    requestIds.push(d.requestId);
    customerPhones.push(d.phone);

    results.summary = {
      a_ok: !results.scenarios.a.rpcError,
      b_fail_reason: isExpectedError({ message: results.scenarios.b.withoutReason.error }, 'reason_required'),
      b_ok_with_reason: !results.scenarios.b.withReason.error,
      b_no_khata: results.scenarios.b.khataTransactionCount === 0,
      c_ok: !results.scenarios.c.rpcError,
      d_fail_late: isExpectedError({ message: results.scenarios.d.withoutLateConfirm.error }, 'late_edit_confirmation_required'),
      d_ok_late: !results.scenarios.d.withLateConfirm.error,
      d_has_correction: (results.scenarios.d.state.khata_transactions ?? []).some((t) => t.note?.includes('Bill edit correction')),
      test2_negative: (results.test2.ledgerAfterEdit?.total_outstanding ?? 0) < 0,
    };
  } finally {
    await cleanup({ requestIds, vendorId, customerPhones });
  }

  const outPath = 'bill-edit-rpc-test-results.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
