/**
 * PROD UI spot-check: payment hygiene amber warning + vendor Remind customer.
 * Run: npx playwright test tests/prod-payment-hygiene-spotcheck.spec.ts --config=playwright.prod-hygiene.config.ts
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { loginAsCustomer, loginAsVendor } from './helpers/browser-setup';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = process.env.VITE_SUPABASE_URL ?? '';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

if (ref !== PROD_REF) {
  throw new Error(`Not PROD: ${ref}`);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

const T = Date.now();
const customerPhone = `88499${String(T).slice(-5)}`;
const vendorPhone = `99599${String(T).slice(-5)}`;
const deviceId = `prod_phr_ui_${T}`;
const VENDOR_DEVICE_ID = `prod_phr_vendor_ui_${T}`;
const msg = `prod-phr-ui-${T}`;

let billId = '';
let requestId = '';
let vendorId = '';

test.beforeAll(async () => {
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
      name: `PHR UI ${T}`,
      shop_name: `!PHR-UI-${T}`,
      phone: vendorPhone,
      upi_id: `phr-ui-${T}@upi`,
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
  vendorId = vendor.id;

  await admin.from('vendor_categories').insert({
    vendor_id: vendorId,
    category_id: category.id,
    status: 'approved',
  });

  for (let i = 0; i < 3; i++) {
    const { data: req } = await admin
      .from('requests')
      .insert({
        vendor_id: vendorId,
        user_phone: `hist-ui-${i}-${vendorId.slice(0, 8)}`,
        device_id: `hist-ui-${i}`,
        message: `hist-ui-${i}`,
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
        vendor_id: vendorId,
        user_phone: `hist-ui-${i}-${vendorId.slice(0, 8)}`,
        total_amount: 100,
        payment_mode: 'upi',
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      });
    }
  }

  const { data: request, error: reqErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
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
  requestId = request.id;

  const { error: billErr } = await admin.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendorId,
    p_customer_phone: customerPhone,
    p_total: 299,
    p_payment_mode: 'cash',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PHR UI item', quantity: 1, unit_price: 299, unit: null }],
  });
  if (billErr) throw new Error(billErr.message);

  const { data: bill } = await admin
    .from('order_bills')
    .select('id')
    .eq('request_id', requestId)
    .single();
  if (!bill) throw new Error('bill missing');
  billId = bill.id;

  const aged = new Date(Date.now() - 35 * 60 * 1000).toISOString();
  await admin.from('order_bills').update({ created_at: aged }).eq('id', billId);
  await admin.from('users').upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  if (requestId) {
    await admin.from('user_notifications').delete().eq('related_id', requestId);
    await admin.from('order_items').delete().eq('request_id', requestId);
    await admin.from('order_bills').delete().eq('request_id', requestId);
    await admin.from('requests').delete().eq('id', requestId);
  }
  if (vendorId) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', customerPhone);
});

test('PROD-PHR-UI: MyOrders amber hygiene warning renders', async ({ page }) => {
  await loginAsCustomer(page, customerPhone, deviceId);
  await page.goto('/my-orders');
  const card = page.getByTestId('order-card').filter({ hasText: msg });
  await expect(card.getByTestId('my-orders-payment-hygiene-warning')).toBeVisible({
    timeout: 20_000,
  });
  await expect(card.getByText(/unpaid for a while/i)).toBeVisible();
});

test('PROD-PHR-VENDOR: Remind customer button visible and sends', async ({ page }) => {
  await loginAsVendor(page, vendorPhone, vendorId, VENDOR_DEVICE_ID);
  await page.goto('/vendor');
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId('incoming-order-card').filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId('incoming-remind-customer-btn')).toBeVisible();
  await card.getByTestId('incoming-remind-customer-btn').click();
  await expect(page.getByText(/reminder sent/i)).toBeVisible({ timeout: 15_000 });

  const { count } = await admin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', customerPhone)
    .eq('type', 'bill_payment_reminder')
    .eq('related_id', requestId);
  expect(count).toBeGreaterThanOrEqual(1);
});
