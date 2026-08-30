/**
 * Phase 1 — Pay Now gating on MyOrders.
 * Pay Now only for: delivery + agent + prepaid + UPI unpaid bill.
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
const CUSTOMER_PHONE = `88005${String(T).slice(-5)}`;
const DEVICE_ID = `device_ppg_${T}`;

const L = {
  payNow: 'Pay Now',
  awaitingVendor: 'Waiting for vendor to confirm payment',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99005${String(T + vendorPhoneSeq).slice(-5)}`;
}

type Scenario = {
  tag: string;
  serviceMode: 'help' | 'delivery' | 'appointment';
  fulfillment?: 'vendor' | 'agent';
  timing?: 'prepaid' | 'postpaid';
  paymentMode: 'cash' | 'upi' | 'khata';
  expectPayNow: boolean;
};

const SCENARIOS: Scenario[] = [
  { tag: 'help-upi', serviceMode: 'help', paymentMode: 'upi', expectPayNow: false },
  {
    tag: 'appt-upi',
    serviceMode: 'appointment',
    paymentMode: 'upi',
    expectPayNow: false,
  },
  {
    tag: 'del-vendor-upi',
    serviceMode: 'delivery',
    fulfillment: 'vendor',
    timing: 'postpaid',
    paymentMode: 'upi',
    expectPayNow: false,
  },
  {
    tag: 'del-agent-post-upi',
    serviceMode: 'delivery',
    fulfillment: 'agent',
    timing: 'postpaid',
    paymentMode: 'upi',
    expectPayNow: false,
  },
  {
    tag: 'del-agent-pre-upi',
    serviceMode: 'delivery',
    fulfillment: 'agent',
    timing: 'prepaid',
    paymentMode: 'upi',
    expectPayNow: true,
  },
  {
    tag: 'del-agent-pre-cash',
    serviceMode: 'delivery',
    fulfillment: 'agent',
    timing: 'prepaid',
    paymentMode: 'cash',
    expectPayNow: false,
  },
];

async function createVendor(serviceMode: Scenario['serviceMode']) {
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PPG Vendor ${serviceMode}`,
      shop_name: `!PPG-${serviceMode}-${T}`,
      phone,
      upi_id: `ppg-${T}@upi`,
      category: category.label,
      service_mode: serviceMode,
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
  return { id: vendor.id as string, categoryId: category.id as string };
}

async function seedOrderWithBill(scenario: Scenario) {
  const vendor = await createVendor(scenario.serviceMode);
  const msg = `PPG ${scenario.tag} ${T}`;

  const requestFields: Record<string, unknown> = {
    vendor_id: vendor.id,
    user_phone: CUSTOMER_PHONE,
    device_id: DEVICE_ID,
    message: msg,
    status: 'fulfilled',
    payment_status: 'unpaid',
    service_mode: scenario.serviceMode,
  };

  if (scenario.serviceMode === 'delivery') {
    requestFields.delivery_slot = 'morning';
    requestFields.delivery_fulfillment_method = scenario.fulfillment ?? 'vendor';
    requestFields.delivery_payment_timing = scenario.timing ?? 'postpaid';
  } else if (scenario.serviceMode === 'appointment') {
    requestFields.appointment_time = new Date(Date.now() + 3600_000).toISOString();
    requestFields.appointment_status = 'confirmed';
  }

  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert(requestFields)
    .select('id')
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const billTotal = 199;
  const { error: billError } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendor.id,
      p_vendor_phone: await vendorPhoneById(vendor.id),
    p_customer_phone: CUSTOMER_PHONE,
    p_total: billTotal,
    p_payment_mode: scenario.paymentMode,
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PPG item', quantity: 1, unit_price: billTotal, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);

  return { msg, expectPayNow: scenario.expectPayNow };
}

function orderCard(page: Page, message: string) {
  return page.getByTestId('order-card').filter({ hasText: message });
}

test.beforeAll(async () => {
  await supabaseAdmin
    .from('users')
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: 'phone' });

  for (const scenario of SCENARIOS) {
    await seedOrderWithBill(scenario);
  }
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

test('PPG-01 — Pay Now appears only for agent+prepaid+delivery+UPI', async ({ page }) => {
  test.setTimeout(120_000);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  for (const scenario of SCENARIOS) {
    const msg = `PPG ${scenario.tag} ${T}`;
    const card = orderCard(page, msg);
    await expect(card).toBeVisible({ timeout: 15000 });

    const payNow = card.getByTestId('my-orders-pay-now-btn');
    const awaiting = card.getByTestId('my-orders-payment-awaiting-vendor');

    if (scenario.expectPayNow) {
      await expect(payNow).toBeVisible();
      await expect(payNow).toHaveText(L.payNow);
      await expect(awaiting).toHaveCount(0);
    } else {
      await expect(payNow).toHaveCount(0);
      await expect(awaiting).toBeVisible();
      await expect(awaiting).toHaveText(L.awaitingVendor);
    }
  }
});
