import { test, expect } from '@playwright/test';
import { supabaseAdmin, createTestVendor, cleanupTestVendors } from './helpers/setup';

const T = Date.now();

let testVendor: { id: string; phone: string };
const createdRequestIds: string[] = [];

test.beforeAll(async () => {
  testVendor = await createTestVendor();
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await cleanupTestVendors();
});

test('OITP-01 — insert_bill_with_items sets total_price on every line item', async () => {
  const customerPhone = `88005${String(T).slice(-5)}`;

  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: customerPhone,
      message: `OITP-01 multi-item ${T}`,
      status: 'fulfilled',
      payment_status: 'unpaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const items = [
    { name: 'Item A', quantity: 2, unit_price: 50, unit: null },
    { name: 'Item B', quantity: 1, unit_price: 100, unit: null },
  ];
  const expectedTotal = 2 * 50 + 1 * 100;

  const { data: billId, error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: testVendor.id,
    p_customer_phone: customerPhone,
    p_total: expectedTotal,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: items,
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);
  expect(billId).toBeTruthy();

  const { data: rows, error: itemsError } = await supabaseAdmin
    .from('order_items')
    .select('description, quantity, unit_price, total_price')
    .eq('request_id', request.id)
    .order('description', { ascending: true });
  if (itemsError) throw itemsError;

  expect(rows).toHaveLength(2);

  for (const row of rows ?? []) {
    expect(row.total_price).not.toBeNull();
    expect(row.total_price).toBe(row.quantity * row.unit_price);
  }

  expect(rows![0].description).toBe('Item A');
  expect(rows![0].total_price).toBe(100);
  expect(rows![1].description).toBe('Item B');
  expect(rows![1].total_price).toBe(100);
});
