/**
 * Section 5c — payment dispute backstop: restriction trigger, claim gate, UI copy, cron lift.
 */
import { test, expect, Page } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';

const T = Date.now();
const DEVICE_ID = `device_pdb_${T}`;
const DEVICE_ONLY_ID = `device_pdb_only_${T}`;
const UTR = '123456789012';

function customerPhone(suffix: string): string {
  return `88007${String(T).slice(-4)}${suffix}`;
}

async function ensureCustomer(phone: string) {
  if (!createdCustomerPhones.includes(phone)) {
    createdCustomerPhones.push(phone);
    await supabaseAdmin
      .from('users')
      .upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  }
}

const L = {
  payNow: 'Pay Now',
  cashOnly:
    'Online payment is temporarily unavailable on your account. Please pay cash to the vendor.',
  awaitingVendor: 'Waiting for vendor to confirm payment',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99007${String(T + vendorPhoneSeq).slice(-5)}`;
}

type VendorRef = { id: string; phone: string };

async function createDeliveryVendor(tag: string): Promise<VendorRef> {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PDB Vendor ${tag}`,
      shop_name: `!PDB-${tag}-${T}`,
      phone,
      upi_id: `pdb-${tag}-${T}@upi`,
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
  await seedVendorPaidHistory(vendor.id, [100, 100, 100]);
  return { id: vendor.id as string, phone: vendor.phone as string };
}

async function seedVendorPaidHistory(vendorId: string, amounts: number[]) {
  for (let i = 0; i < amounts.length; i++) {
    const { data: req, error } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: vendorId,
        user_phone: `hist-${i}-${vendorId.slice(0, 8)}`,
        device_id: `hist-${i}-${vendorId.slice(0, 8)}`,
        message: `hist-${i}`,
        status: 'fulfilled',
        service_mode: 'delivery',
        delivery_fulfillment_method: 'agent',
        delivery_payment_timing: 'prepaid',
      })
      .select('id')
      .single();
    if (error) throw error;
    createdRequestIds.push(req.id);
    await supabaseAdmin.from('order_bills').insert({
      request_id: req.id,
      vendor_id: vendorId,
      user_phone: `hist-${i}-${vendorId.slice(0, 8)}`,
      total_amount: amounts[i],
      payment_mode: 'upi',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
    });
  }
}

async function seedPrepaidAgentOrder(opts: {
  vendorId: string;
  message: string;
  userPhone?: string | null;
  deviceId: string;
}) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: opts.vendorId,
      user_phone: opts.userPhone ?? null,
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
    p_customer_phone: opts.userPhone ?? null,
    p_total: 250,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PDB item', quantity: 1, unit_price: 250, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);

  return request.id as string;
}

async function claimAndDispute(requestId: string, vendorPhone: string, identity: {
  userPhone?: string | null;
  deviceId: string;
}) {
  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: identity.deviceId,
    p_user_phone: identity.userPhone ?? null,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const { error: disputeErr } = await supabase.rpc('dispute_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendorPhone,
  });
  if (disputeErr) throw new Error(`dispute failed: ${disputeErr.message}`);
}

async function restrictionStatus(identity: { userPhone?: string | null; deviceId: string }) {
  const { data, error } = await supabase.rpc('get_customer_payment_restriction_status', {
    p_user_phone: identity.userPhone ?? null,
    p_device_id: identity.deviceId,
  });
  if (error) throw error;
  return Boolean(data?.[0]?.is_restricted);
}

function orderCard(page: Page, message: string) {
  return page.getByTestId('order-card').filter({ hasText: message });
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
    .in('identity_key', [...createdCustomerPhones, DEVICE_ONLY_ID]);
  if (createdCustomerPhones.length) {
    await supabaseAdmin
      .from('user_notifications')
      .delete()
      .in('user_phone', createdCustomerPhones)
      .eq('type', 'account_restored');
    await supabaseAdmin.from('users').delete().in('phone', createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('PDB-01 — single vendor dispute does not restrict', async () => {
  const phone = customerPhone('1');
  await ensureCustomer(phone);
  const deviceId = `${DEVICE_ID}_1`;
  const vendor = await createDeliveryVendor('single');
  const requestId = await seedPrepaidAgentOrder({
    vendorId: vendor.id,
    message: `PDB single ${T}`,
    userPhone: phone,
    deviceId,
  });

  await claimAndDispute(requestId, vendor.phone, {
    userPhone: phone,
    deviceId,
  });

  expect(await restrictionStatus({ userPhone: phone, deviceId })).toBe(false);

  const { data: row } = await supabaseAdmin
    .from('customer_payment_restrictions')
    .select('is_restricted, last_dispute_at')
    .eq('identity_key', phone)
    .maybeSingle();
  expect(row?.is_restricted).toBe(false);
  expect(row?.last_dispute_at).toBeTruthy();
});

test('PDB-02 — two distinct vendor disputes restrict identity', async () => {
  const phone = customerPhone('2');
  await ensureCustomer(phone);
  const deviceId = `${DEVICE_ID}_2`;
  const vendorA = await createDeliveryVendor('two-a');
  const vendorB = await createDeliveryVendor('two-b');
  const identity = { userPhone: phone, deviceId };

  const reqA = await seedPrepaidAgentOrder({
    vendorId: vendorA.id,
    message: `PDB two-a ${T}`,
    ...identity,
  });
  const reqB = await seedPrepaidAgentOrder({
    vendorId: vendorB.id,
    message: `PDB two-b ${T}`,
    ...identity,
  });

  await claimAndDispute(reqA, vendorA.phone, identity);
  expect(await restrictionStatus(identity)).toBe(false);

  await claimAndDispute(reqB, vendorB.phone, identity);
  expect(await restrictionStatus(identity)).toBe(true);

  const { count } = await supabaseAdmin
    .from('payment_dispute_events')
    .select('vendor_id', { count: 'exact', head: true })
    .eq('user_phone', phone);
  expect(count).toBeGreaterThanOrEqual(2);
});

test('PDB-03 — claim_customer_payment rejects restricted identity server-side', async () => {
  const phone = customerPhone('3');
  await ensureCustomer(phone);
  const deviceId = `${DEVICE_ID}_3`;
  const vendor = await createDeliveryVendor('claim-gate');
  const requestId = await seedPrepaidAgentOrder({
    vendorId: vendor.id,
    message: `PDB claim-gate ${T}`,
    userPhone: phone,
    deviceId,
  });

  await supabaseAdmin.from('customer_payment_restrictions').upsert({
    identity_key: phone,
    is_restricted: true,
    restricted_at: new Date().toISOString(),
    last_dispute_at: new Date().toISOString(),
  });

  const { error } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: deviceId,
    p_user_phone: phone,
  });

  expect(error).not.toBeNull();
  expect(error?.message).toContain('payment_self_declare_restricted');
});

test('PDB-04 — device-only identity path restricts after two vendor disputes', async () => {
  const vendorA = await createDeliveryVendor('dev-a');
  const vendorB = await createDeliveryVendor('dev-b');
  const identity = { userPhone: null, deviceId: DEVICE_ONLY_ID };

  const reqA = await seedPrepaidAgentOrder({
    vendorId: vendorA.id,
    message: `PDB dev-a ${T}`,
    ...identity,
  });
  const reqB = await seedPrepaidAgentOrder({
    vendorId: vendorB.id,
    message: `PDB dev-b ${T}`,
    ...identity,
  });

  await claimAndDispute(reqA, vendorA.phone, identity);
  await claimAndDispute(reqB, vendorB.phone, identity);

  expect(await restrictionStatus(identity)).toBe(true);

  const { data: row } = await supabaseAdmin
    .from('customer_payment_restrictions')
    .select('identity_key, is_restricted')
    .eq('identity_key', DEVICE_ONLY_ID)
    .single();
  expect(row?.is_restricted).toBe(true);
});

test('PDB-05 — cron lifts restriction after 90-day-old timestamps', async () => {
  const phone = customerPhone('5');
  await ensureCustomer(phone);
  const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();

  await supabaseAdmin.from('customer_payment_restrictions').upsert({
    identity_key: phone,
    is_restricted: true,
    restricted_at: old,
    last_dispute_at: old,
  });

  const { error: liftErr } = await supabaseAdmin.rpc('lift_expired_payment_restrictions');
  expect(liftErr).toBeNull();

  const { data: row } = await supabaseAdmin
    .from('customer_payment_restrictions')
    .select('is_restricted, restricted_at')
    .eq('identity_key', phone)
    .single();
  expect(row?.is_restricted).toBe(false);
  expect(row?.restricted_at).toBeNull();

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('type, title')
    .eq('user_phone', phone)
    .eq('type', 'account_restored')
    .order('created_at', { ascending: false })
    .limit(1);
  expect(notifications?.[0]?.type).toBe('account_restored');
});

test('PDB-06 — Pay Now hidden with cash-only copy when restricted (browser)', async ({ page }) => {
  test.setTimeout(120_000);

  const phone = customerPhone('6');
  await ensureCustomer(phone);
  const deviceId = `${DEVICE_ID}_6`;
  const vendor = await createDeliveryVendor('ui');
  const message = `PDB ui ${T}`;
  await seedPrepaidAgentOrder({
    vendorId: vendor.id,
    message,
    userPhone: phone,
    deviceId,
  });

  await supabaseAdmin.from('customer_payment_restrictions').upsert({
    identity_key: phone,
    is_restricted: true,
    restricted_at: new Date().toISOString(),
    last_dispute_at: new Date().toISOString(),
  });

  await loginAsCustomer(page, phone, deviceId);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const card = orderCard(page, message);
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('my-orders-pay-now-btn')).toHaveCount(0);
  await expect(card.getByTestId('my-orders-payment-cash-only')).toBeVisible();
  await expect(card.getByTestId('my-orders-payment-cash-only')).toHaveText(L.cashOnly);
  await expect(card.getByTestId('my-orders-payment-awaiting-vendor')).toHaveCount(0);
});
