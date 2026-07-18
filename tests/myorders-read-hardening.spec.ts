import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

// MyOrders read-path hardening (OTP-off identity model).
// `supabase` is the anon-key client with NO Supabase Auth session — exactly how
// OTP-off production callers reach the DB. `supabaseAdmin` is seed/cleanup only.
// Covers: get_my_orders / get_my_order_bills / get_my_khata_ledger /
// get_my_khata_transactions, ownership scoping, rate limiting, and the
// defensive claim_customer_payment check for voided-bill cancelled orders.

const T = Date.now();
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [];
const rlIdentifiers: string[] = [];
const RL_ACTIONS = [
  'get_my_orders',
  'get_my_order_bills',
  'get_my_khata_ledger',
  'get_my_khata_transactions',
];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  rlIdentifiers.push(phone);
  return phone;
}

async function seedVendor(shopName: string) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'MyOrders Read Vendor',
      shop_name: shopName,
      phone: nextPhone('99072'),
      category: cat.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return data.id as string;
}

async function seedRequest(
  vendorId: string,
  userPhone: string | null,
  deviceId: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: deviceId,
      message: `myorders-read-${T}-${createdRequestIds.length}`,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

async function seedBill(
  requestId: string,
  vendorId: string,
  userPhone: string | null,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: requestId,
      vendor_id: vendorId,
      user_phone: userPhone,
      total_amount: 250,
      payment_mode: 'cash',
      payment_status: 'unpaid',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

test.afterAll(async () => {
  for (const id of createdRequestIds) {
    await supabaseAdmin.from('order_items').delete().eq('request_id', id);
    await supabaseAdmin.from('order_bills').delete().eq('request_id', id);
    await supabaseAdmin.from('requests').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  if (rlIdentifiers.length > 0) {
    for (const action of RL_ACTIONS) {
      await supabaseAdmin
        .from('edge_function_rate_limits')
        .delete()
        .eq('function_name', action)
        .in('identifier', rlIdentifiers);
    }
  }
});

test('MOR-01 — get_my_orders returns a no-session phone caller\'s non-done orders; direct read stays blocked', async () => {
  const vendorId = await seedVendor(`!MOR01-${T}`);
  const phone = nextPhone('88073');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  const sentId = await seedRequest(vendorId, phone, `devMOR01_${T}`);
  const doneId = await seedRequest(vendorId, phone, `devMOR01_${T}`, { status: 'done' });

  // Direct anon read still blocked (RLS stays restrictive — this is the PROD bug).
  const direct = await supabase.from('requests').select('id').eq('user_phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  // RPC returns the sent order (with vendor fields), excludes done.
  const { data, error } = await supabase.rpc('get_my_orders', {
    p_user_phone: phone,
    p_device_id: `devMOR01_${T}`,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{ id: string; status: string; vendor_shop_name: string | null }>;
  expect(rows.map((r) => r.id)).toContain(sentId);
  expect(rows.map((r) => r.id)).not.toContain(doneId);
  const sentRow = rows.find((r) => r.id === sentId)!;
  expect(sentRow.vendor_shop_name).toBe(`!MOR01-${T}`);
});

test('MOR-02 — get_my_orders device-scoped when no phone; other identities see nothing', async () => {
  const vendorId = await seedVendor(`!MOR02-${T}`);
  const deviceId = `devMOR02_${T}`;
  const reqId = await seedRequest(vendorId, null, deviceId);

  const { data, error } = await supabase.rpc('get_my_orders', {
    p_user_phone: null,
    p_device_id: deviceId,
  });
  expect(error, error?.message).toBeNull();
  expect(((data ?? []) as Array<{ id: string }>).map((r) => r.id)).toContain(reqId);

  // A different device sees nothing.
  const { data: other } = await supabase.rpc('get_my_orders', {
    p_user_phone: null,
    p_device_id: `devMOR02_other_${T}`,
  });
  expect(((other ?? []) as Array<{ id: string }>).map((r) => r.id)).not.toContain(reqId);

  // No identity at all → identity_required.
  const { error: noIdErr } = await supabase.rpc('get_my_orders', {
    p_user_phone: null,
    p_device_id: null,
  });
  expect(noIdErr?.message ?? '').toContain('identity_required');
});

test('MOR-03 — get_my_order_bills: non-void bills with items + edited flag; void excluded; foreign requests excluded', async () => {
  const vendorId = await seedVendor(`!MOR03-${T}`);
  const phone = nextPhone('88074');
  const otherPhone = nextPhone('88075');
  await supabaseAdmin.from('users').upsert(
    [{ phone, trust_score: 75 }, { phone: otherPhone, trust_score: 75 }],
    { onConflict: 'phone' },
  );

  const myReq = await seedRequest(vendorId, phone, `devMOR03_${T}`);
  const myVoidReq = await seedRequest(vendorId, phone, `devMOR03_${T}`);
  const foreignReq = await seedRequest(vendorId, otherPhone, `devMOR03_other_${T}`);

  const myBillId = await seedBill(myReq, vendorId, phone);
  await seedBill(myVoidReq, vendorId, phone, { payment_status: 'void' });
  await seedBill(foreignReq, vendorId, otherPhone);

  const { error: itemErr } = await supabaseAdmin.from('order_items').insert({
    request_id: myReq,
    description: 'Paracetamol',
    quantity: 2,
    unit: 'strip',
    unit_price: 30,
  });
  expect(itemErr).toBeNull();

  // Caller asks for all three request ids — must only get their own non-void bill.
  const { data, error } = await supabase.rpc('get_my_order_bills', {
    p_user_phone: phone,
    p_device_id: `devMOR03_${T}`,
    p_request_ids: [myReq, myVoidReq, foreignReq],
  });
  expect(error, error?.message).toBeNull();
  const bills = (data ?? []) as Array<{
    id: string;
    request_id: string;
    payment_status: string;
    items: Array<{ description: string; total_price: number }>;
    is_edited: boolean;
  }>;
  expect(bills.length).toBe(1);
  expect(bills[0].id).toBe(myBillId);
  expect(bills[0].request_id).toBe(myReq);
  expect(bills[0].payment_status).toBe('unpaid');
  expect(bills[0].is_edited).toBe(false);
  expect(bills[0].items.length).toBe(1);
  expect(bills[0].items[0].description).toBe('Paracetamol');

  // Direct anon read of order_bills stays blocked.
  const direct = await supabase.from('order_bills').select('id').eq('user_phone', phone);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);
});

test('MOR-04 — khata ledger + transactions RPCs return own rows for no-session caller', async () => {
  const vendorId = await seedVendor(`!MOR04-${T}`);
  const phone = nextPhone('88076');
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });

  const { error: ledgerErr } = await supabaseAdmin.from('khata_ledger').insert({
    vendor_id: vendorId,
    user_phone: phone,
    total_outstanding: 320,
  });
  expect(ledgerErr).toBeNull();
  const { error: txErr } = await supabaseAdmin.from('khata_transactions').insert({
    vendor_id: vendorId,
    user_phone: phone,
    amount: 320,
    note: 'bill added',
    payment_mode: 'khata',
  });
  expect(txErr).toBeNull();

  // Direct anon reads blocked.
  const directLedger = await supabase.from('khata_ledger').select('vendor_id').eq('user_phone', phone);
  expect(directLedger.data).toEqual([]);
  const directTx = await supabase.from('khata_transactions').select('id').eq('user_phone', phone);
  expect(directTx.data).toEqual([]);

  // RPCs work without a session.
  const { data: ledger, error: lErr } = await supabase.rpc('get_my_khata_ledger', {
    p_user_phone: phone,
  });
  expect(lErr, lErr?.message).toBeNull();
  const ledgerRows = (ledger ?? []) as Array<{ vendor_id: string; total_outstanding: number; shop_name: string | null }>;
  expect(ledgerRows.length).toBe(1);
  expect(ledgerRows[0].vendor_id).toBe(vendorId);
  expect(ledgerRows[0].total_outstanding).toBe(320);
  expect(ledgerRows[0].shop_name).toBe(`!MOR04-${T}`);

  const { data: txs, error: tErr } = await supabase.rpc('get_my_khata_transactions', {
    p_user_phone: phone,
    p_vendor_id: vendorId,
  });
  expect(tErr, tErr?.message).toBeNull();
  const txRows = (txs ?? []) as Array<{ amount: number; note: string | null }>;
  expect(txRows.length).toBe(1);
  expect(Number(txRows[0].amount)).toBe(320);

  // Missing phone → identity_required.
  const { error: noIdErr } = await supabase.rpc('get_my_khata_ledger', { p_user_phone: null });
  expect(noIdErr?.message ?? '').toContain('identity_required');
});

test('MOR-05 — get_my_orders rate limit: 31st call in a minute rejected', async () => {
  const phone = nextPhone('88077');
  let rateLimited = false;
  for (let i = 0; i < 31; i += 1) {
    const { error } = await supabase.rpc('get_my_orders', {
      p_user_phone: phone,
      p_device_id: null,
    });
    if (error?.message.includes('rate_limited')) {
      rateLimited = true;
      expect(i).toBeGreaterThanOrEqual(30);
      break;
    }
    expect(error, error?.message).toBeNull();
  }
  expect(rateLimited).toBe(true);
});

test('MOR-06 — defensive: claim_customer_payment rejects a claim against a cancelled order with a voided bill', async () => {
  const vendorId = await seedVendor(`!MOR06-${T}`);
  const phone = nextPhone('88078');
  const deviceId = `devMOR06_${T}`;
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  const reqId = await seedRequest(vendorId, phone, deviceId);
  await seedBill(reqId, vendorId, phone, { payment_mode: 'upi' });

  // Cancel (voids the bill server-side — tonight's cancel fix).
  const { error: cancelErr } = await supabase.rpc('cancel_customer_order', {
    p_request_id: reqId,
    p_device_id: deviceId,
    p_user_phone: phone,
  });
  expect(cancelErr, cancelErr?.message).toBeNull();

  const { data: bill } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('request_id', reqId)
    .single();
  expect(bill?.payment_status).toBe('void');

  // Even if a stale UI still shows Pay Now, the claim RPC must reject:
  // claim_customer_payment requires status='fulfilled'; this order is 'cancelled'.
  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: reqId,
    p_payment_utr: '123456789012',
    p_device_id: deviceId,
    p_user_phone: phone,
  });
  expect(claimErr?.message ?? '').toContain('not_found_or_unauthorized');

  // Request payment state untouched.
  const { data: reqRow } = await supabaseAdmin
    .from('requests')
    .select('status, payment_status')
    .eq('id', reqId)
    .single();
  expect(reqRow?.status).toBe('cancelled');
  expect(reqRow?.payment_status ?? null).not.toBe('claimed');
});
