/**
 * Browser verification of the two MyOrders UI fixes:
 *   1) Stale bill after cancel — voided bill must clear without a full reload
 *      (loadBills no longer early-returns past the state update).
 *   2) Cancel-reason banner — customer cancels show "You cancelled this order";
 *      vendor cancels with a reason show that reason.
 */
import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const CUSTOMER_PHONE = `88101${String(T).slice(-5)}`;
const DEVICE_ID = `device_mo_ui_${T}`;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99101${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function seedVendor(shopName: string) {
  const category = await getActiveCategoryByLabel('Pharmacy');
  const vendorPhone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'MyOrders UI Vendor',
      shop_name: shopName,
      phone: vendorPhone,
      category: category.label,
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
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);
  return { id: vendor.id as string, phone: vendorPhone };
}

async function seedOrder(
  vendorId: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

test.beforeAll(async () => {
  await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  for (const id of createdRequestIds) {
    await supabaseAdmin.from('order_bills').delete().eq('request_id', id);
    await supabaseAdmin.from('requests').delete().eq('id', id);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('MO-UI-01 — stale unpaid bill clears without reload after cancel_customer_order voids it', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const vendor = await seedVendor(`!mo-ui-stale-${T}`);
  const msg = `mo-ui-stale-${T}`;
  const requestId = await seedOrder(vendor.id, msg);
  await supabaseAdmin.from('order_bills').insert({
    request_id: requestId,
    vendor_id: vendor.id,
    user_phone: CUSTOMER_PHONE,
    total_amount: 180,
    payment_mode: 'cash',
    payment_status: 'unpaid',
  });

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const card = page.getByTestId('order-card').filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByText('⏳ Unpaid')).toBeVisible({ timeout: 10000 });
  await expect(card.getByRole('button', { name: 'Pay Now' })).toBeVisible();

  // Cancel server-side (same RPC the UI uses). Realtime will flip the status
  // pill; the bill clear depends on the next silent poll (loadBills).
  const { error: cancelErr } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: requestId,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(cancelErr).toBeNull();

  const { data: bill } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status')
    .eq('request_id', requestId)
    .single();
  expect(bill?.payment_status).toBe('void');

  // Status pill updates via realtime (or the silent poll).
  await expect(card.getByText(/You cancelled/i).first()).toBeVisible({ timeout: 40000 });

  // Wait past the 30s silent poll so loadBills re-runs against the voided bill.
  // After the fix, Unpaid / Pay Now must be gone WITHOUT a page reload.
  await expect(card.getByText('⏳ Unpaid')).toHaveCount(0, { timeout: 45000 });
  await expect(card.getByRole('button', { name: 'Pay Now' })).toHaveCount(0);

  // Banner must say the customer cancelled (not the vendor default).
  await expect(card.getByText('You cancelled this order')).toBeVisible();
});

test('MO-UI-02 — vendor cancel with a reason shows that reason; customer cancel shows you-cancelled banner', async ({
  page,
}) => {
  test.setTimeout(90_000);

  const vendor = await seedVendor(`!mo-ui-banner-${T}`);
  const customerMsg = `mo-ui-banner-cust-${T}`;
  const vendorMsg = `mo-ui-banner-vend-${T}`;
  const customerReq = await seedOrder(vendor.id, customerMsg);
  const vendorReq = await seedOrder(vendor.id, vendorMsg, { status: 'accepted' });

  // Customer cancel (no cancel_reason recorded by cancel_customer_order).
  const { error: cErr } = await supabaseAdmin.rpc('cancel_customer_order', {
    p_request_id: customerReq,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(cErr).toBeNull();

  // Vendor cancel with an explicit reason (vendor_cancel_order writes cancel_reason).
  const { error: vErr } = await supabaseAdmin.rpc('vendor_cancel_order', {
    p_request_id: vendorReq,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_cancel_reason: 'Out of stock today',
    p_cancel_appointment: false,
  });
  expect(vErr).toBeNull();

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const customerCard = page.getByTestId('order-card').filter({ hasText: customerMsg });
  await expect(customerCard).toBeVisible({ timeout: 15000 });
  await expect(customerCard.getByText('You cancelled this order')).toBeVisible();
  await expect(customerCard.getByText('Vendor cancelled this order')).toHaveCount(0);

  const vendorCard = page.getByTestId('order-card').filter({ hasText: vendorMsg });
  await expect(vendorCard).toBeVisible({ timeout: 15000 });
  await expect(vendorCard.getByText('Out of stock today')).toBeVisible();
  // Status pill for vendor cancel with a reason.
  await expect(vendorCard.getByText(/Cancelled by vendor/i).first()).toBeVisible();
});
