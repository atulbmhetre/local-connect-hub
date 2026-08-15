/**
 * Payment hygiene reminders: cron tier1/tier2, vendor remind button, copy branches, MyOrders warning.
 */
import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestVendors,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from './helpers/setup';
import { uniqueTestPhone } from './helpers/session38';

const T = Date.now();

async function invokeRemindUnpaidBills(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('remind_unpaid_bills');
  expect(error, error?.message).toBeNull();
}

type SeedBillOpts = {
  paymentMode?: 'cash' | 'upi' | 'khata';
  requestPaymentStatus?: string;
  serviceMode?: 'delivery' | 'help' | 'appointment';
  billAgeMs?: number;
  tier1At?: string | null;
  tier2At?: string | null;
};

async function seedUnpaidBillScenario(
  tag: string,
  opts: SeedBillOpts = {},
): Promise<{
  vendorId: string;
  vendorPhone: string;
  customerPhone: string;
  requestId: string;
  billId: string;
  shopName: string;
}> {
  const customerPhone = uniqueTestPhone(`883${tag.slice(-2)}`);
  const serviceMode = opts.serviceMode ?? 'delivery';
  const category = await getActiveCategoryByServiceMode(serviceMode);
  const shopName = `PHR-${tag}-${T}`;
  const vendorPhone = uniqueTestPhone(`984${tag.slice(-2)}`);

  const { data: vendor, error: vendorErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `PHR Vendor ${tag}`,
      shop_name: shopName,
      phone: vendorPhone,
      upi_id: `phr-${T}@upi`,
      category: category.label,
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
    })
    .select('id, phone')
    .single();
  if (vendorErr) throw vendorErr;
  await seedVendorCategory(vendor.id, category);

  await supabaseAdmin
    .from('users')
    .upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: 'phone' });

  const { data: request, error: reqErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      message: `phr-${tag}-${T}`,
      status: 'fulfilled',
      payment_status: opts.requestPaymentStatus ?? 'unpaid',
    })
    .select('id')
    .single();
  if (reqErr) throw reqErr;

  const { data: bill, error: billErr } = await supabaseAdmin
    .from('order_bills')
    .insert({
      request_id: request.id,
      vendor_id: vendor.id,
      user_phone: customerPhone,
      total_amount: 250,
      payment_mode: opts.paymentMode ?? 'cash',
      payment_status: 'unpaid',
      payment_reminder_tier1_at: opts.tier1At ?? null,
      payment_reminder_tier2_at: opts.tier2At ?? null,
    })
    .select('id')
    .single();
  if (billErr) throw billErr;

  if (opts.billAgeMs != null) {
    const createdAt = new Date(Date.now() - opts.billAgeMs).toISOString();
    const { error: ageErr } = await supabaseAdmin
      .from('order_bills')
      .update({ created_at: createdAt })
      .eq('id', bill.id);
    expect(ageErr, ageErr?.message).toBeNull();
  }

  return {
    vendorId: vendor.id as string,
    vendorPhone: vendor.phone as string,
    customerPhone,
    requestId: request.id as string,
    billId: bill.id as string,
    shopName,
  };
}

async function cleanupScenario(
  customerPhone: string,
  requestId: string,
  billId: string,
  vendorId: string,
) {
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', customerPhone);
  await supabaseAdmin.from('order_bills').delete().eq('id', billId);
  await supabaseAdmin.from('requests').delete().eq('id', requestId);
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
  await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
}

async function waitForReminderNotifications(customerPhone: string, minCount = 1) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { data, error } = await supabaseAdmin
      .from('user_notifications')
      .select('id, title, body, type')
      .eq('user_phone', customerPhone)
      .eq('type', 'bill_payment_reminder')
      .order('created_at', { ascending: false });
    if (error) throw error;
    if ((data?.length ?? 0) >= minCount) return data ?? [];
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Expected >= ${minCount} bill_payment_reminder for ${customerPhone}`);
}

test.describe('payment hygiene reminders (DB)', () => {
  test('PHR-01 — tier1 cron fires once (31min backdate, invoke twice, one notification + tier1_at)', async () => {
    const seeded = await seedUnpaidBillScenario('01', { billAgeMs: 31 * 60 * 1000 });
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    await invokeRemindUnpaidBills();
    await invokeRemindUnpaidBills();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 1);
    expect(rows.length).toBe(1);

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_reminder_tier1_at, payment_reminder_tier2_at')
      .eq('id', seeded.billId)
      .single();
    expect(bill?.payment_reminder_tier1_at).not.toBeNull();
    expect(bill?.payment_reminder_tier2_at).toBeNull();

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });

  test('PHR-02 — tier2 cron fires once at 24h', async () => {
    const tier1At = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const seeded = await seedUnpaidBillScenario('02', {
      billAgeMs: 25 * 60 * 60 * 1000,
      tier1At,
    });
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    await invokeRemindUnpaidBills();
    await invokeRemindUnpaidBills();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 1);
    expect(rows.length).toBe(1);

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('payment_reminder_tier2_at')
      .eq('id', seeded.billId)
      .single();
    expect(bill?.payment_reminder_tier2_at).not.toBeNull();

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });

  test('PHR-03 — vendor remind RPC has no server cooldown (two rapid calls succeed)', async () => {
    const seeded = await seedUnpaidBillScenario('03');
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    const rpcArgs = {
      p_bill_id: seeded.billId,
      p_source: 'vendor',
      p_vendor_id: seeded.vendorId,
      p_vendor_phone: seeded.vendorPhone,
    };

    const first = await supabase.rpc('send_bill_payment_reminder', rpcArgs);
    expect(first.error, first.error?.message).toBeNull();

    const second = await supabase.rpc('send_bill_payment_reminder', rpcArgs);
    expect(second.error, second.error?.message).toBeNull();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 2);
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const { data: bill } = await supabaseAdmin
      .from('order_bills')
      .select('last_vendor_reminder_at')
      .eq('id', seeded.billId)
      .single();
    expect(bill?.last_vendor_reminder_at).not.toBeNull();

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });

  test('PHR-04 — copy: UPI delivery self-declare pay now body', async () => {
    const seeded = await seedUnpaidBillScenario('04', {
      paymentMode: 'upi',
      serviceMode: 'delivery',
    });
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    const { error } = await supabaseAdmin.rpc('send_bill_payment_reminder', {
      p_bill_id: seeded.billId,
      p_source: 'cron',
    });
    expect(error, error?.message).toBeNull();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 1);
    expect(rows[0].body).toContain('Pay Now');
    expect(rows[0].body).toContain(seeded.shopName);

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });

  test('PHR-05 — copy: claimed reminder has no Pay Now', async () => {
    const seeded = await seedUnpaidBillScenario('05', {
      paymentMode: 'upi',
      requestPaymentStatus: 'claimed',
    });
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    const { error } = await supabaseAdmin.rpc('send_bill_payment_reminder', {
      p_bill_id: seeded.billId,
      p_source: 'cron',
    });
    expect(error, error?.message).toBeNull();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 1);
    expect(rows[0].body).not.toContain('Pay Now');
    expect(rows[0].body.toLowerCase()).toMatch(/utr|confirmation|confirm/);

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });

  test('PHR-06 — copy: cash generic contact vendor', async () => {
    const seeded = await seedUnpaidBillScenario('06', { paymentMode: 'cash' });
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', seeded.customerPhone);

    const { error } = await supabaseAdmin.rpc('send_bill_payment_reminder', {
      p_bill_id: seeded.billId,
      p_source: 'cron',
    });
    expect(error, error?.message).toBeNull();

    const rows = await waitForReminderNotifications(seeded.customerPhone, 1);
    expect(rows[0].body).not.toContain('Pay Now');
    expect(rows[0].body.toLowerCase()).toContain('contact');

    await cleanupScenario(
      seeded.customerPhone,
      seeded.requestId,
      seeded.billId,
      seeded.vendorId,
    );
  });
});

test('PHR-07 — browser: MyOrders shows hygiene warning past tier1', async ({ page }) => {
  test.setTimeout(120_000);

  const deviceId = `device_phr07_${T}`;
  const seeded = await seedUnpaidBillScenario('07', { billAgeMs: 31 * 60 * 1000 });

  await loginAsCustomer(page, seeded.customerPhone, deviceId);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId('my-orders-screen')).toBeVisible({ timeout: 20000 });

  const card = page.getByTestId('order-card').filter({ hasText: seeded.shopName });
  await expect(card).toBeVisible({ timeout: 15000 });
  await expect(card.getByTestId('my-orders-payment-hygiene-warning')).toBeVisible({
    timeout: 20000,
  });
  await expect(card.getByTestId('my-orders-payment-hygiene-warning')).toContainText(
    'unpaid for over 30 minutes',
  );

  await cleanupScenario(
    seeded.customerPhone,
    seeded.requestId,
    seeded.billId,
    seeded.vendorId,
  );
});
