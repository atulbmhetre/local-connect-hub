import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
} from './helpers/setup';

let testVendor: { id: string; phone: string };

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

function uniqueCustomerPhone(): string {
  return `8800${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

async function seedRequest(vendorId: string, userPhone: string | null): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      message: `Add bill to khata ${TEST_SESSION}`,
      status: 'fulfilled',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function insertCashBill(opts: {
  requestId: string;
  vendorId: string;
  customerPhone: string | null;
  total: number;
}): Promise<string> {
  const { data, error } = await supabase.rpc('insert_bill_with_items', {
    p_order_id: opts.requestId,
    p_vendor_id: opts.vendorId,
    p_customer_phone: opts.customerPhone,
    p_total: opts.total,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'Test item', quantity: 1, unit_price: opts.total, unit: null }],
  });
  if (error) throw new Error(`insert_bill_with_items failed: ${error.message}`);
  return data as string;
}

async function callAddBillToKhata(
  billId: string,
  vendorId: string,
  vendorPhone: string,
) {
  return supabase.rpc('add_bill_to_khata', {
    p_bill_id: billId,
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
  });
}

async function getLedgerOutstanding(
  vendorId: string,
  userPhone: string,
): Promise<number | null> {
  const { data } = await supabaseAdmin
    .from('khata_ledger')
    .select('total_outstanding')
    .eq('vendor_id', vendorId)
    .eq('user_phone', userPhone)
    .maybeSingle();
  return data?.total_outstanding ?? null;
}

async function cleanupKhataForPhone(userPhone: string) {
  await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', userPhone);
  await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', userPhone);
}

async function cleanupRequest(requestId: string) {
  await supabaseAdmin.from('order_items').delete().eq('request_id', requestId);
  await supabaseAdmin.from('order_bills').delete().eq('request_id', requestId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
}

test('ABK-01: happy path — first khata entry charges ledger by bill total', async () => {
  const userPhone = uniqueCustomerPhone();
  const requestId = await seedRequest(testVendor.id, userPhone);
  const billTotal = 250;

  try {
    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: userPhone,
      total: billTotal,
    });

    const { error } = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(error).toBeNull();

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_mode, payment_status, total_amount')
      .eq('id', billId)
      .single();
    expect(bill?.payment_mode).toBe('khata');
    expect(bill?.payment_status).toBe('unpaid');
    expect(bill?.total_amount).toBe(billTotal);

    const { data: txn } = await supabaseAdmin
      .from('khata_transactions')
      .select('vendor_id, user_phone, amount, note, payment_mode, request_id')
      .eq('vendor_id', testVendor.id)
      .eq('user_phone', userPhone)
      .eq('request_id', requestId)
      .single();
    expect(txn?.amount).toBe(billTotal);
    expect(txn?.note).toBe('Added to khata');
    expect(txn?.payment_mode).toBe('khata');

    expect(await getLedgerOutstanding(testVendor.id, userPhone)).toBe(billTotal);
  } finally {
    await cleanupKhataForPhone(userPhone);
    await cleanupRequest(requestId);
  }
});

test('ABK-02: happy path — adds to existing ledger outstanding', async () => {
  const userPhone = uniqueCustomerPhone();
  const requestId = await seedRequest(testVendor.id, userPhone);
  const priorOutstanding = 200;
  const billTotal = 150;

  try {
    const { error: ledgerSeedError } = await supabaseAdmin.from('khata_ledger').insert({
      vendor_id: testVendor.id,
      user_phone: userPhone,
      total_outstanding: priorOutstanding,
    });
    expect(ledgerSeedError).toBeNull();

    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: userPhone,
      total: billTotal,
    });

    const { error } = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(error).toBeNull();

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_mode, payment_status, total_amount')
      .eq('id', billId)
      .single();
    expect(bill?.payment_mode).toBe('khata');
    expect(bill?.payment_status).toBe('unpaid');
    expect(bill?.total_amount).toBe(billTotal);

    const { data: txn } = await supabaseAdmin
      .from('khata_transactions')
      .select('amount, note, payment_mode, request_id')
      .eq('vendor_id', testVendor.id)
      .eq('user_phone', userPhone)
      .eq('request_id', requestId)
      .single();
    expect(txn?.amount).toBe(billTotal);
    expect(txn?.note).toBe('Added to khata');
    expect(txn?.payment_mode).toBe('khata');

    expect(await getLedgerOutstanding(testVendor.id, userPhone)).toBe(
      priorOutstanding + billTotal,
    );
  } finally {
    await cleanupKhataForPhone(userPhone);
    await cleanupRequest(requestId);
  }
});

test('ABK-03: bill_not_unpaid — paid bill cannot be moved to khata', async () => {
  const userPhone = TEST_CUSTOMER_PHONE;
  const requestId = await seedRequest(testVendor.id, userPhone);
  const billTotal = 300;

  try {
    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: userPhone,
      total: billTotal,
    });

    const outstandingBefore = await getLedgerOutstanding(testVendor.id, userPhone);

    const { error: markPaidError } = await supabaseAdmin
      .from('order_bills')
      .update({ payment_status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', billId);
    expect(markPaidError).toBeNull();

    const { error } = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('bill_not_unpaid');

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_mode, payment_status')
      .eq('id', billId)
      .single();
    expect(bill?.payment_mode).toBe('cash');
    expect(bill?.payment_status).toBe('paid');

    expect(await getLedgerOutstanding(testVendor.id, userPhone)).toBe(outstandingBefore);

    const { count } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId)
      .eq('note', 'Added to khata');
    expect(count ?? 0).toBe(0);
  } finally {
    await cleanupKhataForPhone(userPhone);
    await cleanupRequest(requestId);
  }
});

test('ABK-04: bill_already_khata — second call rejected and ledger charged once', async () => {
  const userPhone = uniqueCustomerPhone();
  const requestId = await seedRequest(testVendor.id, userPhone);
  const billTotal = 175;

  try {
    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: userPhone,
      total: billTotal,
    });

    const first = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(first.error).toBeNull();

    const second = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toContain('bill_already_khata');

    expect(await getLedgerOutstanding(testVendor.id, userPhone)).toBe(billTotal);

    const { count } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId)
      .eq('note', 'Added to khata');
    expect(count).toBe(1);
  } finally {
    await cleanupKhataForPhone(userPhone);
    await cleanupRequest(requestId);
  }
});

test('ABK-05: customer_phone_required — bill without user_phone is rejected', async () => {
  const requestId = await seedRequest(testVendor.id, null);
  const billTotal = 120;

  try {
    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: null,
      total: billTotal,
    });

    const { error } = await callAddBillToKhata(billId, testVendor.id, testVendor.phone);
    expect(error).not.toBeNull();
    expect(error?.message).toContain('customer_phone_required');

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_mode')
      .eq('id', billId)
      .single();
    expect(bill?.payment_mode).toBe('cash');

    const { count } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId);
    expect(count ?? 0).toBe(0);
  } finally {
    await cleanupRequest(requestId);
  }
});

test('ABK-06: unauthorised — wrong vendor phone is rejected with no writes', async () => {
  const userPhone = uniqueCustomerPhone();
  const requestId = await seedRequest(testVendor.id, userPhone);
  const billTotal = 90;

  try {
    const billId = await insertCashBill({
      requestId,
      vendorId: testVendor.id,
      customerPhone: userPhone,
      total: billTotal,
    });

    const { error } = await callAddBillToKhata(billId, testVendor.id, '9900099999');
    expect(error).not.toBeNull();
    expect(error?.message).toContain('unauthorised');

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_mode')
      .eq('id', billId)
      .single();
    expect(bill?.payment_mode).toBe('cash');
    expect(await getLedgerOutstanding(testVendor.id, userPhone)).toBeNull();

    const { count } = await supabaseAdmin
      .from('khata_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('request_id', requestId);
    expect(count ?? 0).toBe(0);
  } finally {
    await cleanupKhataForPhone(userPhone);
    await cleanupRequest(requestId);
  }
});

test('ABK-07: bill_not_found — random bill id is rejected', async () => {
  const fakeBillId = crypto.randomUUID();

  const { error } = await callAddBillToKhata(fakeBillId, testVendor.id, testVendor.phone);
  expect(error).not.toBeNull();
  expect(error?.message).toContain('bill_not_found');
});
