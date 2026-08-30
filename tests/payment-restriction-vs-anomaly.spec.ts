/**
 * Section 5c vs Phase 2 — account restriction must win over anomaly screenshot gate.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const UTR = '123456789012';

const L = {
  payNow: 'Pay Now',
  cashOnly:
    'Online payment is temporarily unavailable on your account. Please pay cash to the vendor.',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function customerPhone(suffix: string): string {
  return `88008${String(T).slice(-4)}${suffix}`;
}

function deviceId(suffix: string): string {
  return `device_prv_${suffix}_${T}`;
}

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99008${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function ensureCustomer(phone: string) {
  if (!createdCustomerPhones.includes(phone)) {
    createdCustomerPhones.push(phone);
    await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  }
}

async function createDeliveryVendor(tag: string) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PRV Vendor ${tag}`,
      shop_name: `!PRV-${tag}-${T}`,
      phone,
      upi_id: `prv-${tag}-${T}@upi`,
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
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  return { id: vendor.id as string, phone: vendor.phone as string };
}

async function seedAnomalousPrepaidOrder(opts: {
  vendorId: string;
  message: string;
  userPhone: string;
  deviceId: string;
  billTotal?: number;
}) {
  const total = opts.billTotal ?? 500;
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: opts.vendorId,
      user_phone: opts.userPhone,
      device_id: opts.deviceId,
      message: opts.message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const { error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: opts.vendorId,
      p_vendor_phone: await vendorPhoneById(opts.vendorId),
    p_customer_phone: opts.userPhone,
    p_total: total,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PRV item', quantity: 1, unit_price: total, unit: null }],
  });
  if (billError) throw new Error(`insert_bill failed: ${billError.message}`);
  return request.id as string;
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('payment_dispute_events').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  await supabaseAdmin
    .from('customer_payment_restrictions')
    .delete()
    .in('identity_key', createdCustomerPhones);
  if (createdCustomerPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('PRV-01 — restricted account: no Pay Now, cash-only copy, no screenshot UI on anomalous order', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const phone = customerPhone('1');
  const dev = deviceId('1');
  await ensureCustomer(phone);

  const vendor = await createDeliveryVendor('anomaly');
  const message = `PRV restricted anomaly ${T}`;
  await seedAnomalousPrepaidOrder({
    vendorId: vendor.id,
    message,
    userPhone: phone,
    deviceId: dev,
  });

  const { data: requirements, error: reqErr } = await supabase.rpc('get_payment_claim_requirements', {
    p_request_id: createdRequestIds[createdRequestIds.length - 1],
    p_device_id: dev,
    p_user_phone: phone,
  });
  expect(reqErr).toBeNull();
  expect(requirements?.requires_screenshot).toBe(true);
  expect(requirements?.is_anomalous).toBe(true);

  await supabaseAdmin.from('customer_payment_restrictions').upsert({
    identity_key: phone,
    is_restricted: true,
    restricted_at: new Date().toISOString(),
    last_dispute_at: new Date().toISOString(),
  });

  await loginAsCustomer(page, phone, dev);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const card = page.getByTestId('order-card').filter({ hasText: message });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('my-orders-pay-now-btn')).toHaveCount(0);
  await expect(card.getByTestId('my-orders-payment-cash-only')).toBeVisible();
  await expect(card.getByTestId('my-orders-payment-cash-only')).toHaveText(L.cashOnly);
  await expect(page.getByTestId('payment-sheet')).toHaveCount(0);
  await expect(page.getByTestId('payment-sheet-screenshot-section')).toHaveCount(0);
});

test('PRV-02 — claim_customer_payment checks restriction before anomaly screenshot gate', async () => {
  const phone = customerPhone('2');
  const dev = deviceId('2');
  await ensureCustomer(phone);

  const vendor = await createDeliveryVendor('rpc-order');
  const requestId = await seedAnomalousPrepaidOrder({
    vendorId: vendor.id,
    message: `PRV rpc order ${T}`,
    userPhone: phone,
    deviceId: dev,
    billTotal: 600,
  });

  const { data: requirements } = await supabase.rpc('get_payment_claim_requirements', {
    p_request_id: requestId,
    p_device_id: dev,
    p_user_phone: phone,
  });
  expect(requirements?.requires_screenshot).toBe(true);

  await supabaseAdmin.from('customer_payment_restrictions').upsert({
    identity_key: phone,
    is_restricted: true,
    restricted_at: new Date().toISOString(),
    last_dispute_at: new Date().toISOString(),
  });

  const { error } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: dev,
    p_user_phone: phone,
  });

  expect(error).not.toBeNull();
  expect(error?.message ?? '').toContain('payment_self_declare_restricted');
  expect(error?.message ?? '').not.toContain('payment_screenshot_required');

  const { data: row } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(row?.payment_status).toBe('unpaid');
});
