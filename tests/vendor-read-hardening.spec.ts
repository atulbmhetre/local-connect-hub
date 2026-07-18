import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

// Vendor read-path hardening (OTP-off identity model).
// `supabase` is anon/no-session — matches real VendorMode (localStorage only).
// Confirmed broken on PROD: direct requests/order_bills/khata_* reads return 0
// rows under auth_user_phone() RLS. These RPCs are the fix.

const T = Date.now();
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdBillIds: string[] = [];
const createdPhones: string[] = [];
const rlIdentifiers: string[] = [];
const RL_ACTIONS = [
  'get_vendor_incoming_orders',
  'get_vendor_incoming_orders_count',
  'get_vendor_order_bills',
  'get_vendor_khata_ledger',
  'get_vendor_khata_request_ids',
  'get_vendor_khata_dismiss_txs',
  'get_vendor_khata_transactions',
  'get_vendor_khata_linked_request',
  'get_vendor_bill_line_items',
  'get_vendor_edited_bill_ids',
  'get_vendor_bill_edit_audit',
  'get_vendor_customer_trust',
  'get_my_bill_edit_audit',
];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  rlIdentifiers.push(phone);
  return phone;
}

async function seedVendor(shopName: string, phone?: string) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const vendorPhone = phone ?? nextPhone('99081');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Vendor Read Hardening',
      shop_name: shopName,
      phone: vendorPhone,
      category: cat.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return { id: data.id as string, phone: data.phone as string, categoryId: cat.id as string };
}

async function seedRequest(
  vendorId: string,
  userPhone: string | null,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `devVRH_${T}_${createdRequestIds.length}`,
      message: `vendor-read-${T}-${createdRequestIds.length}`,
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
      total_amount: 150,
      payment_mode: 'cash',
      payment_status: 'unpaid',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdBillIds.push(data.id);
  return data.id as string;
}

test.afterAll(async () => {
  for (const billId of createdBillIds) {
    await supabaseAdmin.from('bill_edit_audit').delete().eq('bill_id', billId);
  }
  for (const id of createdRequestIds) {
    await supabaseAdmin.from('order_items').delete().eq('request_id', id);
    await supabaseAdmin.from('order_bills').delete().eq('request_id', id);
    await supabaseAdmin.from('khata_transactions').delete().eq('request_id', id);
    await supabaseAdmin.from('requests').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', phone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('khata_transactions').delete().eq('vendor_id', id);
    await supabaseAdmin.from('khata_ledger').delete().eq('vendor_id', id);
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

test('VRH-01 — get_vendor_incoming_orders: anon no-session sees own active window; direct read blocked; wrong phone empty', async () => {
  const vendor = await seedVendor(`!VRH01-${T}`);
  const custPhone = nextPhone('88081');
  await supabaseAdmin.from('users').upsert({ phone: custPhone, trust_score: 80 }, { onConflict: 'phone' });

  const sentId = await seedRequest(vendor.id, custPhone, {
    status: 'sent',
    category_id: vendor.categoryId,
  });
  // Older-than-window sent should be excluded (49h ago).
  const staleSentId = await seedRequest(vendor.id, custPhone, {
    status: 'sent',
    created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
  });
  const fulfilledId = await seedRequest(vendor.id, custPhone, {
    status: 'fulfilled',
    created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
  });

  // Direct anon read — the PROD bug shape — stays empty.
  const direct = await supabase.from('requests').select('id').eq('vendor_id', vendor.id);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_vendor_incoming_orders', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_limit: 50,
  });
  expect(error, error?.message).toBeNull();
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  expect(ids).toContain(sentId);
  expect(ids).toContain(fulfilledId);
  expect(ids).not.toContain(staleSentId);

  const sentRow = (data as Array<{ id: string; category_label: string | null }>).find(
    (r) => r.id === sentId,
  )!;
  expect(sentRow.category_label).toBeTruthy();

  const { data: count, error: countErr } = await supabase.rpc(
    'get_vendor_incoming_orders_count',
    { p_vendor_id: vendor.id, p_vendor_phone: vendor.phone },
  );
  expect(countErr, countErr?.message).toBeNull();
  expect(Number(count)).toBeGreaterThanOrEqual(2);

  // Wrong phone → identity fail.
  const { error: wrongErr } = await supabase.rpc('get_vendor_incoming_orders', {
    p_vendor_id: vendor.id,
    p_vendor_phone: nextPhone('99082'),
    p_limit: 50,
  });
  expect(wrongErr?.message ?? '').toMatch(/not_found_or_unauthorized|identity_required/);
});

test('VRH-02 — get_vendor_order_bills + bill line items + edited ids + audit', async () => {
  const vendor = await seedVendor(`!VRH02-${T}`);
  const custPhone = nextPhone('88082');
  const otherVendor = await seedVendor(`!VRH02-other-${T}`);

  const reqId = await seedRequest(vendor.id, custPhone, { status: 'accepted' });
  const voidReq = await seedRequest(vendor.id, custPhone, { status: 'accepted' });
  const foreignReq = await seedRequest(otherVendor.id, custPhone, { status: 'accepted' });

  const billId = await seedBill(reqId, vendor.id, custPhone);
  await seedBill(voidReq, vendor.id, custPhone, { payment_status: 'void' });
  const foreignBill = await seedBill(foreignReq, otherVendor.id, custPhone);

  await supabaseAdmin.from('order_items').insert({
    request_id: reqId,
    description: 'Test Item',
    quantity: 2,
    unit: 'pcs',
    unit_price: 25,
  });

  await supabaseAdmin.from('bill_edit_audit').insert({
    bill_id: billId,
    vendor_id: vendor.id,
    vendor_phone: vendor.phone,
    reason: 'price fix',
    old_total: 100,
    new_total: 150,
    old_items_snapshot: [],
    new_items_snapshot: [],
  });

  // Direct bill read blocked.
  const direct = await supabase.from('order_bills').select('id').eq('vendor_id', vendor.id);
  expect(direct.data).toEqual([]);

  const { data: bills, error } = await supabase.rpc('get_vendor_order_bills', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_request_ids: [reqId, voidReq, foreignReq],
  });
  expect(error, error?.message).toBeNull();
  const billRows = (bills ?? []) as Array<{ id: string; request_id: string }>;
  expect(billRows.map((b) => b.id)).toEqual([billId]);
  expect(billRows.map((b) => b.id)).not.toContain(foreignBill);

  const { data: items, error: itemErr } = await supabase.rpc('get_vendor_bill_line_items', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_request_id: reqId,
  });
  expect(itemErr, itemErr?.message).toBeNull();
  expect((items ?? []).length).toBe(1);
  expect((items as Array<{ description: string }>)[0].description).toBe('Test Item');

  // Wrong vendor cannot read items.
  const { data: stolen } = await supabase.rpc('get_vendor_bill_line_items', {
    p_vendor_id: otherVendor.id,
    p_vendor_phone: otherVendor.phone,
    p_request_id: reqId,
  });
  expect(stolen ?? []).toEqual([]);

  const { data: edited, error: editedErr } = await supabase.rpc('get_vendor_edited_bill_ids', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_bill_ids: [billId, foreignBill],
  });
  expect(editedErr, editedErr?.message).toBeNull();
  expect(((edited ?? []) as Array<{ bill_id: string }>).map((r) => r.bill_id)).toEqual([billId]);

  const { data: audit, error: auditErr } = await supabase.rpc('get_vendor_bill_edit_audit', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_bill_id: billId,
  });
  expect(auditErr, auditErr?.message).toBeNull();
  expect((audit ?? []).length).toBe(1);
  expect(Number((audit as Array<{ old_total: number }>)[0].old_total)).toBe(100);
});

test('VRH-03 — khata ledger / txs / dismiss / linked request match service-role ground truth', async () => {
  const vendor = await seedVendor(`!VRH03-${T}`);
  const custPhone = nextPhone('88083');
  const otherPhone = nextPhone('88084');

  const reqId = await seedRequest(vendor.id, custPhone, { status: 'fulfilled' });

  await supabaseAdmin.from('khata_ledger').insert([
    { vendor_id: vendor.id, user_phone: custPhone, total_outstanding: 500 },
    { vendor_id: vendor.id, user_phone: otherPhone, total_outstanding: 100 },
  ]);
  await supabaseAdmin.from('khata_transactions').insert([
    {
      vendor_id: vendor.id,
      user_phone: custPhone,
      request_id: reqId,
      amount: 500,
      note: 'khata charge',
      payment_mode: 'khata',
    },
    {
      vendor_id: vendor.id,
      user_phone: otherPhone,
      amount: 100,
      note: 'other',
      payment_mode: 'cash',
    },
  ]);

  // Direct anon blocked.
  expect(
    (await supabase.from('khata_ledger').select('user_phone').eq('vendor_id', vendor.id)).data,
  ).toEqual([]);

  const { data: allLedger, error: lErr } = await supabase.rpc('get_vendor_khata_ledger', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_user_phones: null,
  });
  expect(lErr, lErr?.message).toBeNull();
  expect(((allLedger ?? []) as Array<{ user_phone: string }>).map((r) => r.user_phone).sort()).toEqual(
    [custPhone, otherPhone].sort(),
  );

  const { data: filtered } = await supabase.rpc('get_vendor_khata_ledger', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_user_phones: [custPhone],
  });
  expect(((filtered ?? []) as Array<{ user_phone: string; total_outstanding: number }>).length).toBe(1);
  expect(Number((filtered as Array<{ total_outstanding: number }>)[0].total_outstanding)).toBe(500);

  const { data: reqIds } = await supabase.rpc('get_vendor_khata_request_ids', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_request_ids: [reqId],
  });
  expect(((reqIds ?? []) as Array<{ request_id: string }>).map((r) => r.request_id)).toContain(reqId);

  const { data: dismiss } = await supabase.rpc('get_vendor_khata_dismiss_txs', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_request_ids: [reqId],
  });
  expect(((dismiss ?? []) as Array<{ request_id: string }>).length).toBe(1);

  const { data: txs } = await supabase.rpc('get_vendor_khata_transactions', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_user_phone: custPhone,
    p_since: null,
  });
  expect(((txs ?? []) as unknown[]).length).toBe(1);

  const { data: linked } = await supabase.rpc('get_vendor_khata_linked_request', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_user_phone: custPhone,
  });
  expect(linked).toBe(reqId);
});

test('VRH-04 — get_vendor_customer_trust only for phones that ordered from this vendor', async () => {
  const vendor = await seedVendor(`!VRH04-${T}`);
  const custPhone = nextPhone('88085');
  const stranger = nextPhone('88086');
  await supabaseAdmin.from('users').upsert(
    [
      { phone: custPhone, trust_score: 70, total_orders: 3, is_banned: false },
      { phone: stranger, trust_score: 90, total_orders: 9, is_banned: false },
    ],
    { onConflict: 'phone' },
  );
  await seedRequest(vendor.id, custPhone, { status: 'accepted' });

  const direct = await supabase.from('users').select('phone').in('phone', [custPhone, stranger]);
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_vendor_customer_trust', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_phones: [custPhone, stranger],
  });
  expect(error, error?.message).toBeNull();
  const phones = ((data ?? []) as Array<{ phone: string }>).map((r) => r.phone);
  expect(phones).toEqual([custPhone]);
});

test('VRH-05 — get_my_bill_edit_audit customer companion works anon/no-session', async () => {
  const vendor = await seedVendor(`!VRH05-${T}`);
  const custPhone = nextPhone('88087');
  const reqId = await seedRequest(vendor.id, custPhone, { status: 'fulfilled' });
  const billId = await seedBill(reqId, vendor.id, custPhone);
  await supabaseAdmin.from('bill_edit_audit').insert({
    bill_id: billId,
    vendor_id: vendor.id,
    vendor_phone: vendor.phone,
    reason: 'customer-visible',
    old_total: 50,
    new_total: 60,
    old_items_snapshot: [],
    new_items_snapshot: [],
  });

  const { data, error } = await supabase.rpc('get_my_bill_edit_audit', {
    p_user_phone: custPhone,
    p_device_id: `devVRH05_${T}`,
    p_bill_id: billId,
  });
  expect(error, error?.message).toBeNull();
  expect((data ?? []).length).toBe(1);

  const { data: foreign } = await supabase.rpc('get_my_bill_edit_audit', {
    p_user_phone: nextPhone('88088'),
    p_device_id: `devVRH05_other_${T}`,
    p_bill_id: billId,
  });
  expect(foreign ?? []).toEqual([]);
});

test('VRH-06 — get_vendor_incoming_orders rate limit: 31st call rejected', async () => {
  const vendor = await seedVendor(`!VRH06-${T}`);
  let rateLimited = false;
  for (let i = 0; i < 31; i += 1) {
    const { error } = await supabase.rpc('get_vendor_incoming_orders', {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_limit: 10,
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
