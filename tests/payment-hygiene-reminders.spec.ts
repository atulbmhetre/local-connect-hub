/**
 * Section 6a–6c — payment hygiene reminders: cron tiers, vendor button, copy branches, MyOrders visual weight.
 */
import { test, expect, Page } from "@playwright/test";
import { loginAsCustomer, loginAsVendor, APP_URL } from "./helpers/browser-setup";
import {
  supabase,
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
} from "./helpers/setup";

const T = Date.now();
const VENDOR_DEVICE_ID = `device_phr_vendor_${T}`;
const DEVICE_ID = `device_phr_${T}`;
const UTR = "123456789012";

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function customerPhone(suffix: string): string {
  return `88008${String(T).slice(-4)}${suffix}`;
}

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99008${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function ensureCustomer(phone: string) {
  if (!createdCustomerPhones.includes(phone)) {
    createdCustomerPhones.push(phone);
    await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  }
}

async function createDeliveryVendor(tag: string, opts: { prepaidAgent?: boolean } = {}) {
  const category = await getActiveCategoryByServiceMode("delivery");
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `PHR Vendor ${tag}`,
      shop_name: `!PHR-${tag}-${T}`,
      phone,
      upi_id: `phr-${tag}-${T}@upi`,
      category: category.label,
      service_mode: "delivery",
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: "complete",
      service_radius_km: 9999,
    })
    .select("id, phone")
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category);
  createdVendorIds.push(vendor.id);
  for (let i = 0; i < 3; i++) {
    const { data: req } = await supabaseAdmin
      .from("requests")
      .insert({
        vendor_id: vendor.id,
        user_phone: `hist-${i}-${vendor.id.slice(0, 8)}`,
        device_id: `hist-${i}`,
        message: `hist-${i}`,
        status: "fulfilled",
        service_mode: "delivery",
        delivery_fulfillment_method: "agent",
        delivery_payment_timing: "prepaid",
      })
      .select("id")
      .single();
    if (req) {
      await supabaseAdmin.from("order_bills").insert({
        request_id: req.id,
        vendor_id: vendor.id,
        user_phone: `hist-${i}-${vendor.id.slice(0, 8)}`,
        total_amount: 100,
        payment_mode: "upi",
        payment_status: "paid",
        paid_at: new Date().toISOString(),
      });
    }
  }
  return { id: vendor.id as string, phone: vendor.phone as string };
}

async function seedUnpaidBill(opts: {
  vendorId: string;
  message: string;
  userPhone: string;
  deviceId: string;
  paymentMode?: "cash" | "upi";
  prepaidAgent?: boolean;
  paymentStatus?: string;
  billAgeMinutes?: number;
}) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from("requests")
    .insert({
      vendor_id: opts.vendorId,
      user_phone: opts.userPhone,
      device_id: opts.deviceId,
      message: opts.message,
      status: "fulfilled",
      payment_status: opts.paymentStatus ?? "unpaid",
      service_mode: "delivery",
      delivery_slot: "morning",
      delivery_fulfillment_method: opts.prepaidAgent ? "agent" : "vendor",
      delivery_payment_timing: opts.prepaidAgent ? "prepaid" : "postpaid",
    })
    .select("id")
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const { error: billError } = await supabaseAdmin.rpc("insert_bill_with_items", {
    p_order_id: request.id,
    p_vendor_id: opts.vendorId,
      p_vendor_phone: await vendorPhoneById(opts.vendorId),
    p_customer_phone: opts.userPhone,
    p_total: 320,
    p_payment_mode: opts.paymentMode ?? "upi",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: [{ name: "PHR item", quantity: 1, unit_price: 320, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);

  const { data: bill } = await supabaseAdmin
    .from("order_bills")
    .select("id, created_at")
    .eq("request_id", request.id)
    .single();
  if (!bill) throw new Error("bill not found after insert");

  if (opts.billAgeMinutes != null && opts.billAgeMinutes > 0) {
    const aged = new Date(Date.now() - opts.billAgeMinutes * 60 * 1000).toISOString();
    await supabaseAdmin.from("order_bills").update({ created_at: aged }).eq("id", bill.id);
  }

  return { requestId: request.id as string, billId: bill.id as string };
}

async function invokeRemindUnpaidBills() {
  const { data, error } = await supabaseAdmin.rpc("remind_unpaid_bills");
  if (error) throw error;
  return data as { tier1_sent?: number; tier2_sent?: number };
}

async function countReminders(phone: string) {
  const { count } = await supabaseAdmin
    .from("user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_phone", phone)
    .eq("type", "bill_payment_reminder");
  return count ?? 0;
}

async function latestReminderBody(phone: string) {
  const { data } = await supabaseAdmin
    .from("user_notifications")
    .select("body")
    .eq("user_phone", phone)
    .eq("type", "bill_payment_reminder")
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0]?.body as string | undefined;
}

async function gotoVendorAndWaitOrders(page: Page) {
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByTestId("vendor-screen")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("incoming-order-card").first()).toBeVisible({ timeout: 15_000 });
}

async function loginVendorAndWaitOrders(page: Page, vendor: { id: string; phone: string }) {
  await loginAsVendor(page, vendor.phone, vendor.id, VENDOR_DEVICE_ID);
  await gotoVendorAndWaitOrders(page);
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("user_notifications").delete().in("related_id", createdRequestIds);
    await supabaseAdmin.from("order_items").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("order_bills").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdCustomerPhones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", createdCustomerPhones);
    await supabaseAdmin.from("users").delete().in("phone", createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from("vendor_categories").delete().in("vendor_id", createdVendorIds);
    await supabaseAdmin.from("vendors").delete().in("id", createdVendorIds);
  }
});

test("PHR-01: cron tier-1 fires once per bill at 30 min", async () => {
  const phone = customerPhone("01");
  await ensureCustomer(phone);
  const vendor = await createDeliveryVendor("t1");
  const { billId } = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-t1-${T}`,
    userPhone: phone,
    deviceId: DEVICE_ID,
    billAgeMinutes: 31,
  });

  const r1 = await invokeRemindUnpaidBills();
  expect(r1.tier1_sent).toBeGreaterThanOrEqual(1);
  expect(await countReminders(phone)).toBe(1);

  const { data: after1 } = await supabaseAdmin
    .from("order_bills")
    .select("payment_reminder_tier1_at, payment_reminder_tier2_at")
    .eq("id", billId)
    .single();
  expect(after1?.payment_reminder_tier1_at).toBeTruthy();
  expect(after1?.payment_reminder_tier2_at).toBeNull();

  const r2 = await invokeRemindUnpaidBills();
  expect(r2.tier1_sent ?? 0).toBe(0);
  expect(await countReminders(phone)).toBe(1);
});

test("PHR-02: cron tier-2 fires once at 24 h", async () => {
  const phone = customerPhone("02");
  await ensureCustomer(phone);
  const vendor = await createDeliveryVendor("t2");
  const { billId } = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-t2-${T}`,
    userPhone: phone,
    deviceId: DEVICE_ID,
    billAgeMinutes: 24 * 60 + 5,
  });

  const r1 = await invokeRemindUnpaidBills();
  expect((r1.tier1_sent ?? 0) + (r1.tier2_sent ?? 0)).toBeGreaterThanOrEqual(1);
  expect(await countReminders(phone)).toBeGreaterThanOrEqual(1);

  const { data: bill } = await supabaseAdmin
    .from("order_bills")
    .select("payment_reminder_tier1_at, payment_reminder_tier2_at")
    .eq("id", billId)
    .single();
  expect(bill?.payment_reminder_tier2_at).toBeTruthy();

  const before = await countReminders(phone);
  const r2 = await invokeRemindUnpaidBills();
  expect(r2.tier2_sent ?? 0).toBe(0);
  expect(await countReminders(phone)).toBe(before);
});

test("PHR-03: copy branches — pay now, claimed, generic", async () => {
  const phonePay = customerPhone("03a");
  const phoneClaimed = customerPhone("03b");
  const phoneCash = customerPhone("03c");
  await ensureCustomer(phonePay);
  await ensureCustomer(phoneClaimed);
  await ensureCustomer(phoneCash);
  const vendor = await createDeliveryVendor("copy");

  const pay = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-pay-${T}`,
    userPhone: phonePay,
    deviceId: `${DEVICE_ID}-pay`,
    prepaidAgent: true,
    paymentMode: "upi",
  });
  const claimed = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-claimed-${T}`,
    userPhone: phoneClaimed,
    deviceId: `${DEVICE_ID}-claimed`,
    prepaidAgent: true,
    paymentMode: "upi",
  });
  const cash = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-cash-${T}`,
    userPhone: phoneCash,
    deviceId: `${DEVICE_ID}-cash`,
    prepaidAgent: false,
    paymentMode: "cash",
  });

  await supabaseAdmin
    .from("requests")
    .update({ payment_status: "claimed" })
    .eq("id", claimed.requestId);

  const { error: payErr } = await supabase.rpc("send_bill_payment_reminder", {
    p_bill_id: pay.billId,
    p_source: "vendor",
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(payErr).toBeNull();
  const payBody = await latestReminderBody(phonePay);
  expect(payBody?.toLowerCase()).toContain("pay now");

  const { error: claimedErr } = await supabase.rpc("send_bill_payment_reminder", {
    p_bill_id: claimed.billId,
    p_source: "vendor",
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(claimedErr).toBeNull();
  const claimedBody = await latestReminderBody(phoneClaimed);
  expect(claimedBody?.toLowerCase()).toMatch(/confirmation|confirm/);
  expect(claimedBody?.toLowerCase()).not.toContain("pay now");

  const { error: cashErr } = await supabase.rpc("send_bill_payment_reminder", {
    p_bill_id: cash.billId,
    p_source: "vendor",
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(cashErr).toBeNull();
  const cashBody = await latestReminderBody(phoneCash);
  expect(cashBody?.toLowerCase()).toMatch(/contact|vendor|settle/);
  expect(cashBody?.toLowerCase()).not.toContain("pay now");
});

test("PHR-04: vendor remind has no server cooldown — two rapid sends succeed", async () => {
  const phone = customerPhone("04");
  await ensureCustomer(phone);
  const vendor = await createDeliveryVendor("vendor-btn");
  const { billId } = await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-vbtn-${T}`,
    userPhone: phone,
    deviceId: `${DEVICE_ID}-vbtn`,
    paymentMode: "cash",
  });

  for (let i = 0; i < 2; i++) {
    const { error } = await supabase.rpc("send_bill_payment_reminder", {
      p_bill_id: billId,
      p_source: "vendor",
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
    });
    expect(error).toBeNull();
  }

  expect(await countReminders(phone)).toBe(2);

  const { data: bill } = await supabaseAdmin
    .from("order_bills")
    .select("last_vendor_reminder_at")
    .eq("id", billId)
    .single();
  expect(bill?.last_vendor_reminder_at).toBeTruthy();
});

test("PHR-05: MyOrders shows amber hygiene warning past tier-1 threshold", async ({
  page,
}) => {
  const phone = customerPhone("05");
  await ensureCustomer(phone);
  const vendor = await createDeliveryVendor("ui");
  await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-ui-${T}`,
    userPhone: phone,
    deviceId: `${DEVICE_ID}-ui`,
    billAgeMinutes: 35,
    paymentMode: "cash",
  });

  await loginAsCustomer(page, phone, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  const card = page.getByTestId("order-card").filter({ hasText: `phr-ui-${T}` });
  await expect(card.getByTestId("my-orders-payment-hygiene-warning")).toBeVisible();
  await expect(card.getByText(/unpaid for a while/i)).toBeVisible();
});

test("PHR-06: vendor Remind customer button visible and sends reminder", async ({ page }) => {
  const phone = customerPhone("06");
  await ensureCustomer(phone);
  const vendor = await createDeliveryVendor("incoming");
  await seedUnpaidBill({
    vendorId: vendor.id,
    message: `phr-incoming-${T}`,
    userPhone: phone,
    deviceId: `${DEVICE_ID}-incoming`,
    paymentMode: "cash",
  });

  await loginVendorAndWaitOrders(page, vendor);
  const card = page.getByTestId("incoming-order-card").filter({ hasText: `phr-incoming-${T}` });
  await expect(card.getByTestId("incoming-remind-customer-btn")).toBeVisible();
  await card.getByTestId("incoming-remind-customer-btn").click();
  await expect(page.getByText(/reminder sent/i)).toBeVisible({ timeout: 15_000 });
  expect(await countReminders(phone)).toBeGreaterThanOrEqual(1);
});
