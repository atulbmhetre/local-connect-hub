/**
 * Phase 0 — delivery fulfillment method + prepaid/postpaid settings.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const VENDOR_DEVICE_ID = `device_df0_${T}`;

const L = {
  createBill: '📋 Create Bill',
  itemNamePlaceholder: 'Item name',
  sendBill: 'Send Bill',
  confirmSendTitle: 'Send this bill?',
  billUpi: '📱 UPI',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;
let customerPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99004${String(T + vendorPhoneSeq).slice(-5)}`;
}

function nextCustomerPhone(): string {
  customerPhoneSeq += 1;
  const phone = `88004${String(T + customerPhoneSeq).slice(-5)}`;
  createdCustomerPhones.push(phone);
  return phone;
}

async function seedCustomer(phone: string) {
  await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
}

async function createDeliveryVendor(tag: string) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `DF0 Vendor ${tag}`,
      shop_name: `!DF0-${tag}-${T}`,
      phone,
      upi_id: `df0-${tag}-${T}@upi`,
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
  await seedVendorCategory(vendor.id, category, { serves_at_customer_place: true });
  createdVendorIds.push(vendor.id);
  return { vendor, category };
}

async function readVendorCategoryDelivery(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from('vendor_categories')
    .select('delivery_fulfillment_method, delivery_payment_timing')
    .eq('vendor_id', vendorId)
    .single();
  if (error) throw error;
  return data!;
}

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
  for (const phone of createdCustomerPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('DF-01 — vendor_update_profile_and_categories persists delivery fulfillment settings', async () => {
  const { vendor, category } = await createDeliveryVendor('rpc');

  const { error } = await supabase.rpc('vendor_update_profile_and_categories', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { phone: vendor.phone },
    p_category_ids: [category.id],
    p_category_service_modes: ['delivery'],
    p_category_modes: { [category.id]: ['delivery'] },
    p_delivery_fulfillment_methods: ['agent'],
    p_delivery_payment_timings: ['prepaid'],
  });
  expect(error, error?.message).toBeNull();

  const row = await readVendorCategoryDelivery(vendor.id);
  expect(row.delivery_fulfillment_method).toBe('agent');
  expect(row.delivery_payment_timing).toBe('prepaid');

  const { error: postpaidErr } = await supabase.rpc('vendor_update_profile_and_categories', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { phone: vendor.phone },
    p_category_ids: [category.id],
    p_category_service_modes: ['delivery'],
    p_category_modes: { [category.id]: ['delivery'] },
    p_delivery_fulfillment_methods: ['vendor'],
    p_delivery_payment_timings: ['postpaid'],
  });
  expect(postpaidErr, postpaidErr?.message).toBeNull();

  const updated = await readVendorCategoryDelivery(vendor.id);
  expect(updated.delivery_fulfillment_method).toBe('vendor');
  expect(updated.delivery_payment_timing).toBe('postpaid');
});

test('DF-02 — BillSheet per-order override snapshots request only; vendor default unchanged', async ({
  page,
}) => {
  test.setTimeout(120_000);

  const { vendor } = await createDeliveryVendor('override');
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .eq('vendor_id', vendor.id);

  const customerPhone = nextCustomerPhone();
  await seedCustomer(customerPhone);
  const msg = `DF0 override ${T}`;

  const { data: request, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      device_id: `device_df0_cust_${T}`,
      message: msg,
      status: 'accepted',
      service_mode: 'delivery',
      delivery_slot: 'morning',
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;
  createdRequestIds.push(request.id);

  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId('vendor-screen')).toBeVisible({ timeout: 20000 });

  const card = page.getByTestId('incoming-order-card').filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.getByTestId('incoming-bill-btn').click();
  await expect(page.getByTestId('bill-sheet')).toBeVisible({ timeout: 10000 });

  await page.getByTestId('bill-delivery-method-vendor').click();
  await expect(page.getByTestId('bill-delivery-method-vendor')).toHaveClass(/bg-brand/);
  await expect(page.getByTestId('bill-delivery-timing')).toHaveCount(0);

  await page.getByRole('button', { name: L.billUpi }).click();
  await page.getByPlaceholder(L.itemNamePlaceholder).fill('DF0 override item');
  await page.locator('input[aria-label="Unit price"]').fill('275');
  await page.getByTestId('bill-submit-btn').click();

  const dialog = page.getByRole('alertdialog').filter({ hasText: L.confirmSendTitle });
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await dialog.getByRole('button', { name: L.sendBill }).click();

  await expect.poll(async () => {
    const { data } = await supabaseAdmin
      .from('order_bills')
      .select('id')
      .eq('request_id', request.id)
      .neq('payment_status', 'void');
    return data?.length ?? 0;
  }).toBe(1);

  const { data: reqRow } = await supabaseAdmin
    .from('requests')
    .select('delivery_fulfillment_method, delivery_payment_timing')
    .eq('id', request.id)
    .single();
  expect(reqRow?.delivery_fulfillment_method).toBe('vendor');
  expect(reqRow?.delivery_payment_timing).toBe('postpaid');

  const categoryRow = await readVendorCategoryDelivery(vendor.id);
  expect(categoryRow.delivery_fulfillment_method).toBe('agent');
  expect(categoryRow.delivery_payment_timing).toBe('prepaid');
});
