/**
 * Verify bill_edit_audit customer RLS on TEST — run: node scripts/bill-edit-audit-rls-test.mjs
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anonKey || !serviceKey) {
  console.error('Missing env in .env.test');
  process.exit(1);
}

const admin = createClient(url, serviceKey);
const SESSION = `bea_rls_${Date.now()}`;

function testAuthEmail(phone) {
  return `test+91${phone}@aaspaas.invalid`;
}
function testAuthPassword(phone) {
  return `test_pw_${phone}`;
}

async function ensureAuthUser(phone) {
  const email = testAuthEmail(phone);
  const password = testAuthPassword(phone);
  const { error } = await admin.auth.admin.createUser({
    email,
    phone: `+91${phone}`,
    email_confirm: true,
    phone_confirm: true,
    password,
  });
  if (error && !/already|registered|exists/i.test(error.message)) {
    throw error;
  }
}

async function signInAsCustomer(phone) {
  await ensureAuthUser(phone);
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: testAuthEmail(phone),
    password: testAuthPassword(phone),
  });
  if (error) throw error;
  if (!data.session) throw new Error(`No session for ${phone}`);
  return client;
}

async function getCategory() {
  const { data, error } = await admin
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

async function seedVendor() {
  const cat = await getCategory();
  const phone = `9${String(Date.now()).slice(-9)}`;
  const { data: vendorId, error } = await admin.rpc('register_vendor', {
    p_name: `Audit RLS Vendor ${SESSION}`,
    p_shop_name: `Audit RLS Shop ${SESSION}`,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: 'auditrls@upi',
    p_service_mode: cat.service_mode,
    p_vendor_type: 'shop',
    p_vendor_note: SESSION,
    p_latitude: 18.52,
    p_longitude: 73.85,
    p_referral_code: `R${Date.now().toString(36).slice(-5)}`.toUpperCase(),
    p_profile_status: 'complete',
    p_category_ids: [cat.id],
    p_category_service_modes: [cat.service_mode],
  });
  if (error) throw error;
  return { vendorId, vendorPhone: phone };
}

function customerPhone(offset) {
  return `8800${String(Date.now() + offset).slice(-6)}`;
}

async function seedBill(vendorId, userPhone) {
  const { data: req, error: reqErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `Audit RLS ${SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  const { data: billId, error: billErr } = await admin.rpc('insert_bill_with_items', {
    p_order_id: req.id,
    p_vendor_id: vendorId,
    p_customer_phone: userPhone,
    p_total: 100,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: SESSION,
    p_items: [{ name: 'Item', quantity: 1, unit_price: 100, unit: null }],
  });
  if (billErr) throw billErr;

  return { requestId: req.id, billId };
}

async function seedAuditRow({ billId, vendorId, vendorPhone, oldTotal, newTotal }) {
  const snapshot = [{ description: 'Item', quantity: 1, unit: null, unit_price: oldTotal, total_price: oldTotal }];
  const { data, error } = await admin
    .from('bill_edit_audit')
    .insert({
      bill_id: billId,
      vendor_id: vendorId,
      vendor_phone: vendorPhone,
      reason: SESSION,
      old_items_snapshot: snapshot,
      new_items_snapshot: snapshot,
      old_total: oldTotal,
      new_total: newTotal,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function cleanup(ids) {
  const { billIds, requestIds, vendorId, phones } = ids;
  if (billIds?.length) {
    await admin.from('bill_edit_audit').delete().in('bill_id', billIds);
    await admin.from('order_items').delete().in('request_id', requestIds);
    await admin.from('order_bills').delete().in('id', billIds);
  }
  if (requestIds?.length) {
    await admin.from('requests').delete().in('id', requestIds);
  }
  if (vendorId) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  for (const phone of phones ?? []) {
    await admin.from('users').delete().eq('phone', phone);
  }
}

async function main() {
  const phoneA = customerPhone(1);
  const phoneB = customerPhone(2);
  const { vendorId, vendorPhone } = await seedVendor();
  const billA = await seedBill(vendorId, phoneA);
  const billB = await seedBill(vendorId, phoneB);
  const auditA = await seedAuditRow({
    billId: billA.billId,
    vendorId,
    vendorPhone,
    oldTotal: 100,
    newTotal: 90,
  });
  const auditB = await seedAuditRow({
    billId: billB.billId,
    vendorId,
    vendorPhone,
    oldTotal: 100,
    newTotal: 80,
  });

  const cleanupIds = {
    billIds: [billA.billId, billB.billId],
    requestIds: [billA.requestId, billB.requestId],
    vendorId,
    phones: [phoneA, phoneB],
  };

  try {
    const clientA = await signInAsCustomer(phoneA);

    const { data: ownRows, error: ownErr } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billA.billId);
    if (ownErr) throw ownErr;

    const { data: otherRows, error: otherErr } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billB.billId);
    if (otherErr) throw otherErr;

    const { data: allRowsA, error: allErrA } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .in('bill_id', [billA.billId, billB.billId]);
    if (allErrA) throw allErrA;

    const testA = {
      canSeeOwnBill: (ownRows ?? []).length === 1 && ownRows[0].id === auditA,
      cannotSeeOtherBill: (otherRows ?? []).length === 0,
      bulkQueryScoped: (allRowsA ?? []).length === 1 && allRowsA[0].bill_id === billA.billId,
    };

    const clientB = await signInAsCustomer(phoneB);
    const { data: ownRowsB, error: ownErrB } = await clientB
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billB.billId);
    if (ownErrB) throw ownErrB;

    const { data: otherRowsB, error: otherErrB } = await clientB
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billA.billId);
    if (otherErrB) throw otherErrB;

    const testB = {
      canSeeOwnBill: (ownRowsB ?? []).length === 1 && ownRowsB[0].id === auditB,
      cannotSeeOtherBill: (otherRowsB ?? []).length === 0,
    };

    const pass =
      testA.canSeeOwnBill &&
      testA.cannotSeeOtherBill &&
      testA.bulkQueryScoped &&
      testB.canSeeOwnBill &&
      testB.cannotSeeOtherBill;

    console.log(JSON.stringify({ pass, phoneA, phoneB, billA: billA.billId, billB: billB.billId, testA, testB }, null, 2));
    process.exit(pass ? 0 : 1);
  } finally {
    await cleanup(cleanupIds);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
