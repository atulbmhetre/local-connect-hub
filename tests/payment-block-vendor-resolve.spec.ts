/**
 * Section 5c × 6d — vendor Mark Paid escape valve when self-declare is restricted.
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

function customerPhone(suffix: string): string {
  return `88010${String(T).slice(-4)}${suffix}`;
}

function deviceId(suffix: string): string {
  return `device_pbvr_${suffix}_${T}`;
}

const L = {
  restrictedBlockingBillPrefix:
    'Self-declare is unavailable on your account. Ask !PBVR-BLOCK-',
  restrictedBlockingBillSuffix:
    'to confirm your payment directly in their app to clear this overdue bill.',
} as const;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99010${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function ensureCustomer(phone: string) {
  if (!createdCustomerPhones.includes(phone)) {
    createdCustomerPhones.push(phone);
    await supabaseAdmin.from('users').upsert({ phone, trust_score: 75 }, { onConflict: 'phone' });
  }
}

async function createDeliveryVendor(tag: string, withPaidHistory = false) {
  const category = await getActiveCategoryByServiceMode('delivery');
  const phone = nextVendorPhone();
  const shopName = `!PBVR-${tag.toUpperCase()}-${T}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PBVR Vendor ${tag}`,
      shop_name: shopName,
      phone,
      upi_id: `pbvr-${tag}-${T}@upi`,
      category: category.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, { serves_at_customer_place: true });
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      delivery_fulfillment_method: 'agent',
      delivery_payment_timing: 'prepaid',
    })
    .eq('vendor_id', vendor.id);
  createdVendorIds.push(vendor.id);

  if (withPaidHistory) {
    for (let i = 0; i < 3; i++) {
      const histPhone = `hist_${i}_${vendor.id.slice(0, 8)}`;
      const { data: req } = await supabaseAdmin
        .from('requests')
        .insert({
          vendor_id: vendor.id,
          user_phone: histPhone,
          device_id: `hist_${i}_pbvr_${T}`,
          message: `hist-${i}`,
          status: 'fulfilled',
          service_mode: 'delivery',
          delivery_fulfillment_method: 'agent',
          delivery_payment_timing: 'prepaid',
        })
        .select('id')
        .single();
      createdRequestIds.push(req!.id);
      await supabaseAdmin.from('order_bills').insert({
        request_id: req!.id,
        vendor_id: vendor.id,
        user_phone: histPhone,
        total_amount: 100,
        payment_mode: 'upi',
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
      });
    }
  }

  return vendor;
}

async function placeAndBillOrder(
  vendorId: string,
  message: string,
  total: number,
  identity: { phone: string; deviceId: string },
) {
  const { data: requestId, error } = await supabase.rpc('create_customer_request', {
    p_device_id: identity.deviceId,
    p_vendor_id: vendorId,
    p_message: message,
    p_user_phone: identity.phone,
    p_device_id_log: identity.deviceId,
    p_service_mode: 'delivery',
    p_delivery_address: 'PBVR test address',
    p_delivery_slot: 'tomorrow',
  });
  if (error) throw new Error(`create_customer_request failed: ${error.message}`);
  createdRequestIds.push(requestId as string);

  await supabaseAdmin.from('requests').update({ status: 'accepted' }).eq('id', requestId);
  const { error: billErr } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: requestId,
    p_vendor_id: vendorId,
      p_vendor_phone: await vendorPhoneById(vendorId),
    p_customer_phone: identity.phone,
    p_total: total,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PBVR item', quantity: 1, unit_price: total, unit: null }],
  });
  if (billErr) throw new Error(`insert_bill failed: ${billErr.message}`);
  return requestId as string;
}

async function claimAndDispute(
  requestId: string,
  vendorPhone: string,
  identity: { phone: string; deviceId: string },
) {
  const { error: claimErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: identity.deviceId,
    p_user_phone: identity.phone,
  });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);

  const { error: disputeErr } = await supabase.rpc('dispute_upi_payment', {
    p_request_id: requestId,
    p_vendor_phone: vendorPhone,
  });
  if (disputeErr) throw new Error(`dispute failed: ${disputeErr.message}`);
}

async function seedAgedBlockingBill(
  vendorId: string,
  message: string,
  identity: { phone: string; deviceId: string },
): Promise<{ requestId: string; billId: string }> {
  const { data: request, error: reqError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: identity.phone,
      device_id: identity.deviceId,
      message,
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

  const { data: billId, error: billErr } = await supabaseAdmin.rpc('insert_bill_with_items', {
    p_order_id: request.id,
    p_vendor_id: vendorId,
      p_vendor_phone: await vendorPhoneById(vendorId),
    p_customer_phone: identity.phone,
    p_total: 300,
    p_payment_mode: 'upi',
    p_payment_status: 'unpaid',
    p_notes: null,
    p_items: [{ name: 'PBVR block item', quantity: 1, unit_price: 300, unit: null }],
  });
  if (billErr) throw billErr;

  const aged = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from('order_bills').update({ created_at: aged }).eq('id', billId);

  return { requestId: request.id as string, billId: billId as string };
}

async function blockStatus(identity: { phone: string; deviceId: string }) {
  const { data, error } = await supabase.rpc('get_customer_payment_block_status', {
    p_user_phone: identity.phone,
    p_device_id: identity.deviceId,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

async function restrictionStatus(identity: { phone: string; deviceId: string }) {
  const { data, error } = await supabase.rpc('get_customer_payment_restriction_status', {
    p_user_phone: identity.phone,
    p_device_id: identity.deviceId,
  });
  if (error) throw error;
  return Boolean(data?.[0]?.is_restricted);
}

async function seedRestrictedCustomerWithBlockingBill(identity: { phone: string; deviceId: string }) {
  const disputeVendorA = await createDeliveryVendor('dispute-a', true);
  const disputeVendorB = await createDeliveryVendor('dispute-b', true);
  const blockingVendor = await createDeliveryVendor('block', true);
  const targetVendor = await createDeliveryVendor('target', true);

  const reqA = await placeAndBillOrder(disputeVendorA.id, `PBVR dispute-a ${T}`, 150, identity);
  await claimAndDispute(reqA, disputeVendorA.phone, identity);
  expect(await restrictionStatus(identity)).toBe(false);

  const reqB = await placeAndBillOrder(disputeVendorB.id, `PBVR dispute-b ${T}`, 150, identity);
  await claimAndDispute(reqB, disputeVendorB.phone, identity);
  expect(await restrictionStatus(identity)).toBe(true);

  const msgBlocking = `PBVR blocking bill ${T}`;
  const { requestId, billId } = await seedAgedBlockingBill(blockingVendor.id, msgBlocking, identity);

  expect(await blockStatus(identity)).toMatchObject({
    is_blocked: true,
    amount: 300,
    request_id: requestId,
  });
  expect(await restrictionStatus(identity)).toBe(true);

  const { data: blockedOrderId, error: blockErr } = await supabase.rpc('create_customer_request', {
    p_device_id: identity.deviceId,
    p_vendor_id: targetVendor.id,
    p_message: `PBVR blocked attempt ${T}`,
    p_user_phone: identity.phone,
    p_device_id_log: identity.deviceId,
    p_service_mode: 'delivery',
    p_delivery_address: 'blocked attempt',
    p_delivery_slot: 'tomorrow',
  });
  expect(blockedOrderId).toBeNull();
  expect(blockErr?.message ?? '').toContain('customer_payment_block');

  const { error: ivePaidErr } = await supabase.rpc('claim_customer_payment', {
    p_request_id: requestId,
    p_payment_utr: '123456789015',
    p_device_id: identity.deviceId,
    p_user_phone: identity.phone,
  });
  expect(ivePaidErr?.message ?? '').toContain('payment_self_declare_restricted');

  return {
    blockingVendor,
    targetVendor,
    requestId,
    billId,
    msgBlocking,
  };
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('payment_dispute_events').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_items').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('order_bills').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdCustomerPhones.length) {
    await supabaseAdmin
      .from('customer_payment_restrictions')
      .delete()
      .in('identity_key', createdCustomerPhones);
    await supabaseAdmin.from('users').delete().in('phone', createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
});

test('PBVR-01 — vendor_mark_bill_paid clears 6d block while 5c restriction persists', async () => {
  const phone = customerPhone('1');
  const dev = deviceId('1');
  await ensureCustomer(phone);
  const identity = { phone, deviceId: dev };

  const { blockingVendor, targetVendor, requestId, billId } =
    await seedRestrictedCustomerWithBlockingBill(identity);

  const { error: markErr } = await supabase.rpc('vendor_mark_bill_paid', {
    p_bill_id: billId,
    p_vendor_id: blockingVendor.id,
    p_vendor_phone: blockingVendor.phone,
  });
  expect(markErr, markErr?.message).toBeNull();

  const { data: billRow } = await supabaseAdmin
    .from('order_bills')
    .select('payment_status, paid_at')
    .eq('id', billId)
    .single();
  expect(billRow?.payment_status).toBe('paid');
  expect(billRow?.paid_at).toBeTruthy();

  expect(await blockStatus(identity)).toMatchObject({ is_blocked: false });
  expect(await restrictionStatus(identity)).toBe(true);

  const { data: newOrderId, error: orderErr } = await supabase.rpc('create_customer_request', {
    p_device_id: identity.deviceId,
    p_vendor_id: targetVendor.id,
    p_message: `PBVR after vendor paid ${T}`,
    p_user_phone: identity.phone,
    p_device_id_log: identity.deviceId,
    p_service_mode: 'delivery',
    p_delivery_address: 'unblocked attempt',
    p_delivery_slot: 'tomorrow',
  });
  expect(orderErr).toBeNull();
  expect(newOrderId).toBeTruthy();
  if (newOrderId) createdRequestIds.push(newOrderId as string);

  const { data: reqRow } = await supabaseAdmin
    .from('requests')
    .select('payment_status')
    .eq('id', requestId)
    .single();
  expect(reqRow?.payment_status).toBe('unpaid');
});

test('PBVR-02 — blocking bill shows vendor-resolve guidance when self-declare restricted', async ({
  page,
}: {
  page: Page;
}) => {
  const phone = customerPhone('2');
  const dev = deviceId('2');
  await ensureCustomer(phone);
  const identity = { phone, deviceId: dev };

  const { msgBlocking } = await seedRestrictedCustomerWithBlockingBill(identity);

  await loginAsCustomer(page, phone, dev);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const blockingCard = page.getByTestId('order-card').filter({ hasText: msgBlocking });
  await expect(blockingCard).toBeVisible({ timeout: 15000 });
  await expect(blockingCard.getByTestId('my-orders-pay-now-btn')).toHaveCount(0);
  const guidance = blockingCard.getByTestId('my-orders-payment-restricted-blocking-bill');
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText(L.restrictedBlockingBillPrefix);
  await expect(guidance).toContainText(L.restrictedBlockingBillSuffix);
  await expect(blockingCard.getByTestId('my-orders-payment-cash-only')).toHaveCount(0);
});
