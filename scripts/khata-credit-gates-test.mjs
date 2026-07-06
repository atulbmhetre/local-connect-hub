/**
 * Verification for khata credit gates — run: node scripts/khata-credit-gates-test.mjs
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const db = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const results = { tests: {} };

function errMsg(e) {
  return e?.message ?? String(e);
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
    p_name: 'Credit Gate Test',
    p_shop_name: 'Credit Gate Shop',
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: 'creditgate@upi',
    p_service_mode: cat.service_mode,
    p_vendor_type: 'shop',
    p_vendor_note: `credit_${Date.now()}`,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `C${Date.now().toString(36).slice(-5)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [cat.service_mode],
  });
  if (error) throw error;
  return { vendorId, vendorPhone: phone };
}

async function seedRequest(vendorId, userPhone) {
  const { data, error } = await db
    .from('requests')
    .insert({ vendor_id: vendorId, user_phone: userPhone, message: 'credit test', status: 'fulfilled' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function ledger(vendorId, phone) {
  const { data } = await db.from('khata_ledger').select('*').eq('vendor_id', vendorId).eq('user_phone', phone).maybeSingle();
  return data;
}

async function cleanupAll(tracked) {
  for (const rid of tracked.requestIds) {
    await db.from('order_items').delete().eq('request_id', rid);
    await db.from('order_bills').delete().eq('request_id', rid);
    await db.from('khata_transactions').delete().eq('request_id', rid);
    await db.from('requests').delete().eq('id', rid);
  }
  for (const phone of tracked.phones) {
    await db.from('khata_transactions').delete().eq('user_phone', phone);
    await db.from('khata_ledger').delete().eq('user_phone', phone);
  }
  if (tracked.vendorId) await db.from('vendors').delete().eq('id', tracked.vendorId);
}

async function main() {
  const { vendorId, vendorPhone } = await ensureVendor();
  const tracked = { vendorId, requestIds: [], phones: [] };

  try {
    // --- Tests 2-4: over-correction chain ---
    const phoneA = `8800${String(Date.now()).slice(-6)}1`;
    tracked.phones.push(phoneA);
    const requestA = await seedRequest(vendorId, phoneA);
    tracked.requestIds.push(requestA);

    const { data: billId, error: insErr } = await db.rpc('insert_bill_with_items', {
      p_order_id: requestA,
      p_vendor_id: vendorId,
      p_customer_phone: phoneA,
      p_total: 100,
      p_payment_mode: 'khata',
      p_payment_status: 'unpaid',
      p_notes: null,
      p_items: [{ name: 'Item', quantity: 1, unit_price: 100, unit: null }],
    });
    if (insErr) throw insErr;

    await db.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: phoneA,
      p_amount: 80,
      p_note: 'partial',
    });

    const ledgerBeforeEdit = await ledger(vendorId, phoneA);

    const rejectEdit = await db.rpc('vendor_edit_bill', {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_new_items: [{ name: 'Reduced', quantity: 1, unit_price: 10, unit: null }],
      p_reason: 'Over-correction test',
      p_confirmed_late_edit: false,
      p_confirmed_customer_credit: false,
    });

    const billAfterReject = (await db.from('order_bills').select('total_amount').eq('id', billId).single()).data;
    const ledgerAfterReject = await ledger(vendorId, phoneA);

    results.tests['2_reject_without_credit_confirm'] = {
      error: rejectEdit.error ? errMsg(rejectEdit.error) : null,
      data: rejectEdit.data,
      bill_total_after: billAfterReject?.total_amount,
      ledger_outstanding_after: ledgerAfterReject?.total_outstanding,
      ledger_before_edit: ledgerBeforeEdit?.total_outstanding,
    };

    const acceptEdit = await db.rpc('vendor_edit_bill', {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_new_items: [{ name: 'Reduced', quantity: 1, unit_price: 10, unit: null }],
      p_reason: 'Over-correction test',
      p_confirmed_late_edit: false,
      p_confirmed_customer_credit: true,
    });

    const ledgerAfterEdit = await ledger(vendorId, phoneA);

    results.tests['3_accept_with_credit_confirm'] = {
      error: acceptEdit.error ? errMsg(acceptEdit.error) : null,
      data: acceptEdit.data,
      ledger_outstanding: ledgerAfterEdit?.total_outstanding,
    };

    const refund70 = await db.rpc('vendor_record_khata_refund', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: phoneA,
      p_amount: 70,
    });

    const ledgerAfterRefund = await ledger(vendorId, phoneA);

    results.tests['4_refund_70_to_zero'] = {
      error: refund70.error ? errMsg(refund70.error) : null,
      data: refund70.data,
      ledger_outstanding: ledgerAfterRefund?.total_outstanding,
    };

    // --- Test 5: refund on zero/positive outstanding ---
    const refund10OnZero = await db.rpc('vendor_record_khata_refund', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: phoneA,
      p_amount: 10,
    });

    results.tests['5_refund_on_no_credit'] = {
      error: refund10OnZero.error ? errMsg(refund10OnZero.error) : null,
      data: refund10OnZero.data,
      ledger_outstanding: (await ledger(vendorId, phoneA))?.total_outstanding,
    };

    // --- Test 6: payment on negative outstanding ---
    const phoneB = `8800${String(Date.now()).slice(-6)}2`;
    tracked.phones.push(phoneB);
    await db.from('khata_ledger').insert({
      vendor_id: vendorId,
      user_phone: phoneB,
      total_outstanding: -20,
    });

    const payOnCredit = await db.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: phoneB,
      p_amount: 5,
      p_note: 'should fail',
    });

    results.tests['6_payment_on_negative_outstanding'] = {
      error: payOnCredit.error ? errMsg(payOnCredit.error) : null,
      data: payOnCredit.data,
      ledger_outstanding: (await ledger(vendorId, phoneB))?.total_outstanding,
    };
  } finally {
    await cleanupAll(tracked);
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
