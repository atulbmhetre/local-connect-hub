import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  deleteVendorRegistrationArtifacts,
  TEST_SESSION,
} from './helpers/setup';

type IsolatedContext = {
  vendorId: string;
  vendorPhone: string;
  requestIds: string[];
  customerPhones: string[];
};

let phoneCounter = 0;

function uniqueCustomerPhone(): string {
  phoneCounter += 1;
  return `88006${String(Date.now() + phoneCounter).slice(-6)}${phoneCounter}`;
}

function uniqueVendorPhone(): string {
  return `99006${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 10)}`;
}

function expectErrorCode(error: { message: string } | null, code: string) {
  expect(error).not.toBeNull();
  expect(error!.message).toContain(code);
}

async function createIsolatedVendor(): Promise<Pick<IsolatedContext, 'vendorId' | 'vendorPhone'>> {
  const phone = uniqueVendorPhone();
  const vendor = await createTestVendor({
    phone,
    name: `BillEdit ${TEST_SESSION}`,
    shop_name: `BillEdit Shop ${TEST_SESSION}`,
  });
  return { vendorId: vendor.id, vendorPhone: vendor.phone };
}

async function seedRequest(vendorId: string, userPhone: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `Vendor edit bill ${TEST_SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function insertBill(opts: {
  requestId: string;
  vendorId: string;
  customerPhone: string;
  total: number;
  paymentMode: string;
  paymentStatus?: string;
  items?: Array<{ name: string; quantity: number; unit_price: number; unit: string | null }>;
}): Promise<string> {
  const { data, error } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: opts.requestId,
    p_vendor_id: opts.vendorId,
    p_customer_phone: opts.customerPhone,
    p_total: opts.total,
    p_payment_mode: opts.paymentMode,
    p_payment_status: opts.paymentStatus ?? 'unpaid',
    p_notes: null,
    p_items:
      opts.items ?? [{ name: 'Test item', quantity: 1, unit_price: opts.total, unit: null }],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  return data as string;
}

async function callEditBill(opts: {
  billId: string;
  vendorId: string;
  vendorPhone: string;
  items: Array<{ name: string; quantity: number; unit_price: number; unit?: string | null }>;
  reason?: string | null;
  confirmedLateEdit?: boolean;
  confirmedCustomerCredit?: boolean;
}) {
  return supabase.rpc('vendor_edit_bill', {
    p_bill_id: opts.billId,
    p_vendor_id: opts.vendorId,
    p_vendor_phone: opts.vendorPhone,
    p_new_items: opts.items,
    p_reason: opts.reason ?? null,
    p_confirmed_late_edit: opts.confirmedLateEdit ?? false,
    p_confirmed_customer_credit: opts.confirmedCustomerCredit ?? false,
  });
}

async function getLedgerOutstanding(vendorId: string, userPhone: string): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', vendorId)
    .eq('user_phone', userPhone)
    .maybeSingle();
  return data?.total_outstanding ?? null;
}

async function cleanupIsolatedContext(ctx: IsolatedContext) {
  for (const requestId of ctx.requestIds) {
    const { data: bills } = await supabaseAdmin
      .from('order_bills')
      .select('id')
      .eq('request_id', requestId);
    const billIds = (bills ?? []).map((b) => b.id);
    if (billIds.length > 0) {
      await supabaseAdmin.from('bill_edit_audit').delete().in('bill_id', billIds);
    }
    await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
    await supabaseAdmin.from('khata_transactions').delete().eq('request_id', requestId);
    await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
    await supabaseAdmin.from('requests').delete().eq('id', requestId);
  }
  for (const phone of ctx.customerPhones) {
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
  }
  await deleteVendorRegistrationArtifacts(ctx.vendorId);
}

test('VEB-01: fresh unpaid non-khata bill — edit succeeds without reason', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 200,
      paymentMode: 'cash',
      items: [{ name: 'Cash item', quantity: 1, unit_price: 200, unit: null }],
    });

    const { data, error } = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [
        { name: 'Cash item revised', quantity: 2, unit_price: 75, unit: 'kg' },
        { name: 'Extra', quantity: 1, unit_price: 50, unit: null },
      ],
    });

    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('total_amount')
      .eq('id', billId)
      .single();
    expect(bill?.total_amount).toBe(200);

    const { count: khataCount } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId);
    expect(khataCount ?? 0).toBe(0);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-02: paid non-khata bill — reason required; with reason succeeds; no khata row', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 300,
      paymentMode: 'cash',
      items: [{ name: 'Paid item', quantity: 1, unit_price: 300, unit: null }],
    });

    const { error: markPaidError } = await supabase.rpc('vendor_mark_bill_paid', {
      p_bill_id: billId,
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
    });
    expect(markPaidError).toBeNull();

    const withoutReason = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Paid item revised', quantity: 1, unit_price: 250, unit: null }],
    });
    expectErrorCode(withoutReason.error, 'reason_required');

    const withReason = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Paid item revised', quantity: 1, unit_price: 250, unit: null }],
      reason: 'Price correction after payment',
    });
    expect(withReason.error).toBeNull();

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('total_amount, payment_status')
      .eq('id', billId)
      .single();
    expect(bill?.total_amount).toBe(250);
    expect(bill?.payment_status).toBe('paid');

    const { count } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId);
    expect(count ?? 0).toBe(0);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-03: khata bill under 24h — edit with reason succeeds without late confirm', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 150,
      paymentMode: 'khata',
      items: [{ name: 'Khata fresh', quantity: 1, unit_price: 150, unit: null }],
    });

    const { data, error } = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Khata fresh revised', quantity: 1, unit_price: 175, unit: null }],
      reason: 'Added missing item charge',
    });

    expect(error).toBeNull();
    expect(data).toBeTruthy();
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(175);

    const { data: correction } = await supabaseAdmin
      .from('khata_transactions')
      .select('amount, note, payment_mode')
      .eq('request_id', requestId)
      .eq('note', 'Bill edit correction: Added missing item charge')
      .maybeSingle();
    expect(correction?.amount).toBe(25);
    expect(correction?.payment_mode).toBe('khata');
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-04: khata bill over 24h — late confirm required; confirm creates correction row', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 400,
      paymentMode: 'khata',
      items: [{ name: 'Khata old', quantity: 1, unit_price: 400, unit: null }],
    });

    const backdate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { error: backdateError } = await supabaseAdmin
      .from('order_bills')
      .update({ created_at: backdate })
      .eq('id', billId);
    expect(backdateError).toBeNull();

    const withoutLateConfirm = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Khata old revised', quantity: 1, unit_price: 350, unit: null }],
      reason: 'Late correction',
    });
    expectErrorCode(withoutLateConfirm.error, 'late_edit_confirmation_required');

    const withLateConfirm = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Khata old revised', quantity: 1, unit_price: 350, unit: null }],
      reason: 'Late correction',
      confirmedLateEdit: true,
    });
    expect(withLateConfirm.error).toBeNull();
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(350);

    const { data: corrections } = await supabaseAdmin
      .from('khata_transactions')
      .select('amount, note')
      .eq('request_id', requestId)
      .like('note', 'Bill edit correction%');
    expect(corrections?.length).toBeGreaterThan(0);
    expect(corrections?.some((row) => row.amount === -50)).toBe(true);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-05: edit over-correcting khata — credit confirm gate; negative outstanding + correction tx', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 100,
      paymentMode: 'khata',
      items: [{ name: 'Khata item', quantity: 1, unit_price: 100, unit: null }],
    });

    const { error: payError } = await supabase.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: userPhone,
      p_amount: 80,
      p_note: 'Partial payment before over-correction edit',
    });
    expect(payError).toBeNull();
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(20);

    const rejected = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Reduced item', quantity: 1, unit_price: 10, unit: null }],
      reason: 'Over-correction test',
      confirmedCustomerCredit: false,
    });
    expectErrorCode(rejected.error, 'would_create_customer_credit');

    const { data: billAfterReject } = await supabaseAdmin
      .from('order_bills')
      .select('total_amount')
      .eq('id', billId)
      .single();
    expect(billAfterReject?.total_amount).toBe(100);
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(20);

    const accepted = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Reduced item', quantity: 1, unit_price: 10, unit: null }],
      reason: 'Over-correction test',
      confirmedCustomerCredit: true,
    });
    expect(accepted.error).toBeNull();
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(-70);

    const { data: correction } = await supabaseAdmin
      .from('khata_transactions')
      .select('amount, note, payment_mode')
      .eq('request_id', requestId)
      .like('note', 'Bill edit correction%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(correction?.amount).toBe(-90);
    expect(correction?.payment_mode).toBe('khata');
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-06: vendor_record_khata_refund — zeroes credit; rejects invalid refunds', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 100,
      paymentMode: 'khata',
    });

    await supabase.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: userPhone,
      p_amount: 80,
      p_note: 'partial',
    });

    await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [{ name: 'Reduced', quantity: 1, unit_price: 10, unit: null }],
      reason: 'Over-correction test',
      confirmedCustomerCredit: true,
    });
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(-70);

    const refund70 = await supabase.rpc('vendor_record_khata_refund', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: userPhone,
      p_amount: 70,
    });
    expect(refund70.error).toBeNull();
    expect(refund70.data).toMatchObject({ total_outstanding: 0 });
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(0);

    const refundOnZero = await supabase.rpc('vendor_record_khata_refund', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: userPhone,
      p_amount: 10,
    });
    expectErrorCode(refundOnZero.error, 'no_customer_credit');
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(0);

    await supabaseAdmin.from('khata_ledger').update({ total_outstanding: -30 }).eq('vendor_id', vendorId).eq('user_phone', userPhone);

    const refundExceeds = await supabase.rpc('vendor_record_khata_refund', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_user_phone: userPhone,
      p_amount: 50,
    });
    expectErrorCode(refundExceeds.error, 'amount_exceeds_credit');
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(-30);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-07: vendor_record_khata_payment rejects when outstanding is <= 0', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const { error: seedError } = await supabaseAdmin.from('khata_ledger').insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      total_outstanding: -20,
    });
    expect(seedError).toBeNull();

    const payOnCredit = await supabase.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: userPhone,
      p_amount: 5,
      p_note: 'should fail',
    });
    expectErrorCode(payOnCredit.error, 'no_outstanding_balance');
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(-20);

    await supabaseAdmin
      .from('khata_ledger')
      .update({ total_outstanding: 0 })
      .eq('vendor_id', vendorId)
      .eq('user_phone', userPhone);

    const payOnZero = await supabase.rpc('vendor_record_khata_payment', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_customer_phone: userPhone,
      p_amount: 5,
      p_note: 'should fail on zero',
    });
    expectErrorCode(payOnZero.error, 'no_outstanding_balance');
    expect(await getLedgerOutstanding(vendorId, userPhone)).toBe(0);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});

test('VEB-08: bill edit delete+recreates order_items — no stale row references', async () => {
  const { vendorId, vendorPhone } = await createIsolatedVendor();
  const userPhone = uniqueCustomerPhone();
  const ctx: IsolatedContext = { vendorId, vendorPhone, requestIds: [], customerPhones: [userPhone] };

  try {
    const requestId = await seedRequest(vendorId, userPhone);
    ctx.requestIds.push(requestId);

    const billId = await insertBill({
      requestId,
      vendorId,
      customerPhone: userPhone,
      total: 120,
      paymentMode: 'cash',
      items: [
        { name: 'Line A', quantity: 1, unit_price: 70, unit: null },
        { name: 'Line B', quantity: 1, unit_price: 50, unit: null },
      ],
    });

    const { data: itemsBefore } = await supabaseAdmin
      .from('order_items')
      .select('id, description')
      .eq('request_id', requestId)
      .order('description');
    expect(itemsBefore?.length).toBe(2);
    const oldItemIds = (itemsBefore ?? []).map((row) => row.id);

    const { data, error } = await callEditBill({
      billId,
      vendorId,
      vendorPhone,
      items: [
        { name: 'Line A revised', quantity: 2, unit_price: 40, unit: null },
        { name: 'Line C', quantity: 1, unit_price: 30, unit: null },
      ],
    });
    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: itemsAfter } = await supabaseAdmin
      .from('order_items')
      .select('id, description, total_price')
      .eq('request_id', requestId)
      .order('description');
    expect(itemsAfter?.length).toBe(2);
    const newItemIds = (itemsAfter ?? []).map((row) => row.id);

    for (const oldId of oldItemIds) {
      expect(newItemIds).not.toContain(oldId);
      const { data: staleRow } = await supabaseAdmin
        .from('order_items')
        .select('id')
        .eq('id', oldId)
        .maybeSingle();
      expect(staleRow).toBeNull();
    }

    expect(itemsAfter?.map((row) => row.description)).toEqual(['Line A revised', 'Line C']);

    const { data: audit } = await supabaseAdmin
      .from('bill_edit_audit')
      .select('old_items_snapshot, new_items_snapshot, old_total, new_total')
      .eq('bill_id', billId)
      .single();
    expect(audit?.old_total).toBe(120);
    expect(audit?.new_total).toBe(110);
    expect(Array.isArray(audit?.old_items_snapshot)).toBe(true);
    expect((audit?.old_items_snapshot as unknown[]).length).toBe(2);
    expect(Array.isArray(audit?.new_items_snapshot)).toBe(true);
    expect((audit?.new_items_snapshot as unknown[]).length).toBe(2);

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('total_amount')
      .eq('id', billId)
      .single();
    expect(bill?.total_amount).toBe(110);
  } finally {
    await cleanupIsolatedContext(ctx);
  }
});
