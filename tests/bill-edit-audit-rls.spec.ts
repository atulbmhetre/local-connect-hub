import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  supabaseAdmin,
  getFirstActiveCategory,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  TEST_SESSION,
} from './helpers/setup';

dotenv.config({ path: '.env.test' });

const url = process.env.VITE_SUPABASE_URL!;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;

function testAuthEmail(phone: string): string {
  return `test+91${phone}@aaspaas.invalid`;
}

function testAuthPassword(phone: string): string {
  return `test_pw_${phone}`;
}

async function ensureAuthUser(phone: string) {
  const email = testAuthEmail(phone);
  const password = testAuthPassword(phone);
  const { error } = await supabaseAdmin.auth.admin.createUser({
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

async function signInAsCustomer(phone: string) {
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

function customerPhone(offset: number): string {
  return `88014${String(Date.now() + offset).slice(-5)}`;
}

async function seedBill(vendorId: string, userPhone: string) {
  const { data: req, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `Audit RLS ${TEST_SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  const { data: billId, error: billErr } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: req.id,
    p_vendor_id: vendorId,
    p_customer_phone: userPhone,
    p_total: 100,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: TEST_SESSION,
    p_items: [{ name: 'Item', quantity: 1, unit_price: 100, unit: null }],
  });
  if (billErr) throw billErr;

  return { requestId: req.id, billId: billId as string };
}

async function seedAuditRow(opts: {
  billId: string;
  vendorId: string;
  vendorPhone: string;
  oldTotal: number;
  newTotal: number;
}) {
  const snapshot = [
    {
      description: 'Item',
      quantity: 1,
      unit: null,
      unit_price: opts.oldTotal,
      total_price: opts.oldTotal,
    },
  ];
  const { data, error } = await supabaseAdmin
    .from('bill_edit_audit')
    .insert({
      bill_id: opts.billId,
      vendor_id: opts.vendorId,
      vendor_phone: opts.vendorPhone,
      reason: TEST_SESSION,
      old_items_snapshot: snapshot,
      new_items_snapshot: snapshot,
      old_total: opts.oldTotal,
      new_total: opts.newTotal,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

test('BEA-RLS-01 — customer sees own bill_edit_audit rows only (scoped by request phone)', async () => {
  const phoneA = customerPhone(1);
  const phoneB = customerPhone(2);

  const category = await getFirstActiveCategory();
  const vendorPhone = `99014${String(Date.now()).slice(-5)}`;
  const register = await invokeRegisterVendorRpc({
    phone: vendorPhone,
    name: `Audit RLS Vendor ${TEST_SESSION}`,
    shop_name: `Audit RLS Shop ${TEST_SESSION}`,
    category: category.label,
    service_mode: category.service_mode,
    category_ids: [category.id],
    category_service_modes: [category.service_mode],
  });
  expect(register.error).toBeUndefined();
  const vendorId = register.vendorId!;

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

  try {
    const clientA = await signInAsCustomer(phoneA);

    const { data: ownRows, error: ownErr } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billA.billId);
    expect(ownErr).toBeNull();
    expect(ownRows).toHaveLength(1);
    expect(ownRows![0].id).toBe(auditA);

    const { data: otherRows, error: otherErr } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billB.billId);
    expect(otherErr).toBeNull();
    expect(otherRows ?? []).toHaveLength(0);

    const { data: bulkRows, error: bulkErr } = await clientA
      .from('bill_edit_audit')
      .select('id, bill_id')
      .in('bill_id', [billA.billId, billB.billId]);
    expect(bulkErr).toBeNull();
    expect(bulkRows).toHaveLength(1);
    expect(bulkRows![0].bill_id).toBe(billA.billId);

    const clientB = await signInAsCustomer(phoneB);
    const { data: ownRowsB, error: ownErrB } = await clientB
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billB.billId);
    expect(ownErrB).toBeNull();
    expect(ownRowsB).toHaveLength(1);
    expect(ownRowsB![0].id).toBe(auditB);

    const { data: otherRowsB, error: otherErrB } = await clientB
      .from('bill_edit_audit')
      .select('id, bill_id')
      .eq('bill_id', billA.billId);
    expect(otherErrB).toBeNull();
    expect(otherRowsB ?? []).toHaveLength(0);
  } finally {
    await supabaseAdmin.from('bill_edit_audit').delete().in('bill_id', [billA.billId, billB.billId]);
    await supabaseAdmin.from('order_items').delete().in('request_id', [billA.requestId, billB.requestId]);
    await supabaseAdmin.from('order_bills').delete().in('id', [billA.billId, billB.billId]);
    await supabaseAdmin.from('requests').delete().in('id', [billA.requestId, billB.requestId]);
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});
