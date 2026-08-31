/**
 * Live proof: auto-rating must not steal taps from Pay Now on a fulfilled
 * unpaid order, then must prompt once the bill is paid.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const CUSTOMER_PHONE = `88016${String(T).slice(-5)}`;
const DEVICE_ID = `device_ar_unpaid_${T}`;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99016${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function createDeliveryVendor(tag: string): Promise<{ id: string; category_id: string }> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const upiId = `ar-unpaid-${tag}-${T}@upi`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `AR Unpaid Vendor ${tag}`,
      shop_name: `!AR-UNPAID-${tag}-${T}`,
      phone,
      upi_id: upiId,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, { upi_id: upiId });
  createdVendorIds.push(vendor.id);
  return { id: vendor.id as string, category_id: category.id };
}

async function seedFulfilledUnpaidUnrated(
  vendorId: string,
  categoryId: string,
  message: string,
  billTotal: number,
) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message,
      status: 'fulfilled',
      payment_status: 'unpaid',
      service_mode: 'delivery',
      category_id: categoryId,
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
    p_vendor_id: vendorId,
    p_vendor_phone: await vendorPhoneById(vendorId),
    p_customer_phone: CUSTOMER_PHONE,
    p_total: billTotal,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'AR unpaid item', quantity: 1, unit_price: billTotal, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);
  return request.id as string;
}

async function gotoMyOrders(page: Page) {
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });
}

test.beforeAll(async () => {
  await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });
});

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
});

test('AR-UNPAID-01 — fulfilled unpaid unrated: rating sheet stays closed while Pay Now is visible, then auto-opens after paid', async ({
  page,
}) => {
  const vendor = await createDeliveryVendor('live');
  const msg = `AR unpaid ${T}`;
  const requestId = await seedFulfilledUnpaidUnrated(vendor.id, vendor.category_id, msg, 180);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await gotoMyOrders(page);

  const card = page.getByTestId('order-card').filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('my-orders-pay-now-btn')).toBeVisible({ timeout: 10000 });

  // Past the 500ms auto-rating timer (plus bills-load wait). Pay Now must keep the sheet closed.
  await page.waitForTimeout(1500);
  await expect(card.getByTestId('my-orders-pay-now-btn')).toBeVisible();
  await expect(page.getByTestId('rating-sheet')).not.toBeVisible();

  const { error: payError } = await supabaseAdmin
    .from('order_bills')
    .update({
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    })
    .eq('request_id', requestId);
  if (payError) throw new Error(`mark paid failed: ${payError.message}`);

  await supabaseAdmin.from('requests').update({ payment_status: 'paid' }).eq('id', requestId);

  await gotoMyOrders(page);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('rating-sheet')).toBeVisible({ timeout: 8000 });
});
