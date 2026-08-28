/**
 * Section 6d — customer payment block: unresolved digital UPI bills past 48h grace.
 */
import { test, expect, Page } from "@playwright/test";
import { loginAsCustomer, APP_URL } from "./helpers/browser-setup";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  invokeRegisterVendorRpc,
  TEST_SESSION,
} from "./helpers/setup";

const T = Date.now();
const UTR = "123456789012";

function deviceId(suffix: string): string {
  return `device_cpblock_${suffix}_${T}`;
}

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCustomerPhones: string[] = [];
let vendorPhoneSeq = 0;

function customerPhone(suffix: string): string {
  return `88009${String(T).slice(-4)}${suffix}`;
}

function nextVendorPhone(): string {
  vendorPhoneSeq += 1;
  return `99009${String(T + vendorPhoneSeq).slice(-5)}`;
}

async function ensureCustomer(phone: string) {
  if (!createdCustomerPhones.includes(phone)) {
    createdCustomerPhones.push(phone);
    await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  }
}

async function createTargetVendor(tag: string): Promise<{ id: string; phone: string }> {
  const category = await getActiveCategoryByServiceMode("delivery");
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `CPB Target ${tag}`,
      shop_name: `!CPB-TARGET-${tag}-${T}`,
      phone,
      upi_id: `cpb-target-${tag}-${T}@upi`,
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
  await seedVendorCategory(vendor.id, category, {
    serves_at_customer_place: true,
    serves_at_vendor_place: false,
  });
  createdVendorIds.push(vendor.id);
  return { id: vendor.id as string, phone: vendor.phone as string };
}

async function seedVendorPaidHistory(vendorId: string, amounts: number[]) {
  for (let i = 0; i < amounts.length; i++) {
    const { data: req, error } = await supabaseAdmin
      .from("requests")
      .insert({
        vendor_id: vendorId,
        user_phone: `hist-${i}-${vendorId.slice(0, 8)}`,
        device_id: `hist-${i}-${vendorId.slice(0, 8)}`,
        message: `hist-${i}`,
        status: "fulfilled",
        service_mode: "delivery",
        delivery_fulfillment_method: "agent",
        delivery_payment_timing: "prepaid",
      })
      .select("id")
      .single();
    if (error) throw error;
    await supabaseAdmin.from("order_bills").insert({
      request_id: req.id,
      vendor_id: vendorId,
      user_phone: `hist-${i}-${vendorId.slice(0, 8)}`,
      total_amount: amounts[i],
      payment_mode: "upi",
      payment_status: "paid",
      paid_at: new Date().toISOString(),
    });
  }
}

async function createBlockingVendor(
  tag: string,
  shopName: string,
): Promise<{ id: string; phone: string; shop_name: string }> {
  const category = await getActiveCategoryByServiceMode("delivery");
  const phone = nextVendorPhone();
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `CPB Block ${tag}`,
      shop_name: shopName,
      phone,
      upi_id: `cpb-block-${tag}-${T}@upi`,
      category: category.label,
      service_mode: "delivery",
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: "complete",
      service_radius_km: 9999,
    })
    .select("id, phone, shop_name")
    .single();
  if (error) throw error;
  await seedVendorCategory(vendor.id, category, {
    serves_at_customer_place: true,
    serves_at_vendor_place: false,
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      delivery_fulfillment_method: "agent",
      delivery_payment_timing: "prepaid",
    })
    .eq("vendor_id", vendor.id);
  await seedVendorPaidHistory(vendor.id, [100, 100, 100]);
  createdVendorIds.push(vendor.id);
  return {
    id: vendor.id as string,
    phone: vendor.phone as string,
    shop_name: vendor.shop_name as string,
  };
}

async function seedBlockingBill(opts: {
  vendorId: string;
  message: string;
  userPhone?: string | null;
  deviceId: string;
  paymentMode?: "cash" | "upi";
  billAgeHours?: number;
  paymentStatus?: string;
}) {
  const { data: request, error: reqError } = await supabaseAdmin
    .from("requests")
    .insert({
      vendor_id: opts.vendorId,
      user_phone: opts.userPhone ?? null,
      device_id: opts.deviceId,
      message: opts.message,
      status: "fulfilled",
      payment_status: opts.paymentStatus ?? "unpaid",
      service_mode: "delivery",
      delivery_slot: "morning",
      delivery_fulfillment_method: "agent",
      delivery_payment_timing: "prepaid",
    })
    .select("id")
    .single();
  if (reqError) throw reqError;
  createdRequestIds.push(request.id);

  const { error: billError } = await supabaseAdmin.rpc("insert_bill_with_items", {
    p_order_id: request.id,
    p_vendor_id: opts.vendorId,
    p_customer_phone: opts.userPhone ?? null,
    p_total: 250,
    p_payment_mode: opts.paymentMode ?? "upi",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: [{ name: "CPB item", quantity: 1, unit_price: 250, unit: null }],
  });
  if (billError) throw new Error(`insert_bill_with_items failed: ${billError.message}`);

  const { data: bill } = await supabaseAdmin
    .from("order_bills")
    .select("id")
    .eq("request_id", request.id)
    .single();
  if (!bill) throw new Error("bill missing");

  const ageHours = opts.billAgeHours ?? 49;
  const aged = new Date(Date.now() - ageHours * 60 * 60 * 1000).toISOString();
  await supabaseAdmin.from("order_bills").update({ created_at: aged }).eq("id", bill.id);

  return { requestId: request.id as string, billId: bill.id as string };
}

async function tryCreateOrder(opts: {
  vendorId: string;
  userPhone?: string | null;
  deviceId: string;
}) {
  return supabase.rpc("create_customer_request", {
    p_device_id: opts.deviceId,
    p_vendor_id: opts.vendorId,
    p_message: `CPB order attempt ${T}`,
    p_user_phone: opts.userPhone ?? null,
    p_device_id_log: opts.deviceId,
    p_service_mode: "delivery",
    p_delivery_address: "Test address",
    p_delivery_slot: "tomorrow",
  });
}

async function blockStatus(identity: { userPhone?: string | null; deviceId: string }) {
  const { data, error } = await supabase.rpc("get_customer_payment_block_status", {
    p_user_phone: identity.userPhone ?? null,
    p_device_id: identity.deviceId,
  });
  if (error) throw error;
  return data?.[0] ?? null;
}

async function openParchiForVendor(
  page: Page,
  vendor: { id: string; category?: string },
) {
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(["geolocation"]);
  const q = vendor.category ? `&q=${encodeURIComponent(vendor.category)}` : "";
  await page.goto(`${APP_URL}/radar?mode=delivery${q}`);
  const card = page.locator(
    `[data-testid="radar-vendor-card"][data-vendor-id="${vendor.id}"]`,
  );
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByTestId("radar-vendor-card-order-btn").click({ timeout: 10000 });
  await expect(page.getByTestId("parchi-sheet")).toBeVisible({ timeout: 20000 });
}

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("payment_dispute_events").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("order_items").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("order_bills").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdCustomerPhones.length) {
    await supabaseAdmin.from("users").delete().in("phone", createdCustomerPhones);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from("vendor_categories").delete().in("vendor_id", createdVendorIds);
    await supabaseAdmin.from("vendors").delete().in("id", createdVendorIds);
  }
});

test("CPB-01 — phone identity: RPC rejects unpaid UPI bill older than 48h", async () => {
  const phone = customerPhone("01");
  const dev = deviceId("01");
  await ensureCustomer(phone);
  const blockVendor = await createBlockingVendor("01", `!BLOCK-01-${T}`);
  const targetVendor = await createTargetVendor("01");
  await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-01-${T}`,
    userPhone: phone,
    deviceId: dev,
  });

  const status = await blockStatus({ userPhone: phone, deviceId: dev });
  expect(status?.is_blocked).toBe(true);
  expect(status?.amount).toBe(250);

  const { data, error } = await tryCreateOrder({
    vendorId: targetVendor.id,
    userPhone: phone,
    deviceId: dev,
  });
  expect(data).toBeNull();
  expect(error?.message ?? "").toContain("customer_payment_block");
});

test("CPB-02 — device-only identity: RPC rejects unpaid UPI bill older than 48h", async () => {
  const dev = deviceId("02");
  const blockVendor = await createBlockingVendor("02", `!BLOCK-02-${T}`);
  const targetVendor = await createTargetVendor("02");
  await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-02-${T}`,
    userPhone: null,
    deviceId: dev,
  });

  const status = await blockStatus({ userPhone: null, deviceId: dev });
  expect(status?.is_blocked).toBe(true);

  const { data, error } = await tryCreateOrder({
    vendorId: targetVendor.id,
    userPhone: null,
    deviceId: dev,
  });
  expect(data).toBeNull();
  expect(error?.message ?? "").toContain("customer_payment_block");
});

test("CPB-03 — I've Paid clears block immediately", async () => {
  const phone = customerPhone("03");
  const dev = deviceId("03");
  await ensureCustomer(phone);
  const blockVendor = await createBlockingVendor("03", `!BLOCK-03-${T}`);
  const targetVendor = await createTargetVendor("03");
  const { requestId } = await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-03-${T}`,
    userPhone: phone,
    deviceId: dev,
  });

  expect((await blockStatus({ userPhone: phone, deviceId: dev }))?.is_blocked).toBe(true);

  const { error: claimErr } = await supabase.rpc("claim_customer_payment", {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: dev,
    p_user_phone: phone,
  });
  expect(claimErr).toBeNull();

  expect((await blockStatus({ userPhone: phone, deviceId: dev }))?.is_blocked).toBe(false);

  const { data, error } = await tryCreateOrder({
    vendorId: targetVendor.id,
    userPhone: phone,
    deviceId: dev,
  });
  expect(error).toBeNull();
  expect(data).toBeTruthy();
  if (data) createdRequestIds.push(data as string);
});

test("CPB-04 — cash bill older than 48h never blocks", async () => {
  const phone = customerPhone("04");
  const dev = deviceId("04");
  await ensureCustomer(phone);
  const blockVendor = await createBlockingVendor("04", `!BLOCK-04-${T}`);
  const targetVendor = await createTargetVendor("04");
  await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-04-${T}`,
    userPhone: phone,
    deviceId: dev,
    paymentMode: "cash",
  });

  expect((await blockStatus({ userPhone: phone, deviceId: dev }))?.is_blocked).toBe(false);

  const { data, error } = await tryCreateOrder({
    vendorId: targetVendor.id,
    userPhone: phone,
    deviceId: dev,
  });
  expect(error).toBeNull();
  expect(data).toBeTruthy();
  if (data) createdRequestIds.push(data as string);
});

test("CPB-05 — disputed bill does not re-block (Section 5c parity)", async () => {
  const phone = customerPhone("05");
  const dev = deviceId("05");
  await ensureCustomer(phone);
  const blockVendor = await createBlockingVendor("05", `!BLOCK-05-${T}`);
  const targetVendor = await createTargetVendor("05");
  const { requestId } = await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-05-${T}`,
    userPhone: phone,
    deviceId: dev,
  });

  const { error: claimErr } = await supabase.rpc("claim_customer_payment", {
    p_request_id: requestId,
    p_payment_utr: UTR,
    p_device_id: dev,
    p_user_phone: phone,
  });
  expect(claimErr).toBeNull();

  const { error: disputeErr } = await supabase.rpc("dispute_upi_payment", {
    p_request_id: requestId,
    p_vendor_phone: blockVendor.phone,
  });
  expect(disputeErr).toBeNull();

  expect((await blockStatus({ userPhone: phone, deviceId: dev }))?.is_blocked).toBe(false);

  const { data, error } = await tryCreateOrder({
    vendorId: targetVendor.id,
    userPhone: phone,
    deviceId: dev,
  });
  expect(error).toBeNull();
  expect(data).toBeTruthy();
  if (data) createdRequestIds.push(data as string);
});

test("CPB-06 — ParchiSheet proactive check shows vendor and amount", async ({ page }) => {
  const phone = customerPhone("06");
  const dev = deviceId("06");
  await ensureCustomer(phone);
  const blockShop = `!BLOCK-UI-${T}`;
  const blockVendor = await createBlockingVendor("06", blockShop);
  const targetCategory = await getActiveCategoryByServiceMode("delivery");
  const targetVendor = await createTargetVendor("06");

  await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-ui-${T}`,
    userPhone: phone,
    deviceId: dev,
  });

  await loginAsCustomer(page, phone, dev);
  await openParchiForVendor(page, {
    id: targetVendor.id,
    category: targetCategory.label,
  });

  const inset = page.getByTestId("parchi-payment-block");
  await expect(inset).toBeVisible({ timeout: 15000 });
  await expect(inset).toContainText(blockShop);
  await expect(inset).toContainText("250");
  await expect(page.getByTestId("parchi-payment-block-my-orders-link")).toBeVisible();
  await expect(page.getByTestId("parchi-submit-btn")).not.toBeVisible();
});

test("CPB-07 — ParchiSheet defensive branch after stale proactive check", async ({ page }) => {
  const phone = customerPhone("07");
  const dev = deviceId("07");
  await ensureCustomer(phone);
  const blockShop = `!BLOCK-DEF-${T}`;
  const blockVendor = await createBlockingVendor("07", blockShop);
  const targetCategory = await getActiveCategoryByServiceMode("delivery");
  const targetVendor = await createTargetVendor("07");

  await loginAsCustomer(page, phone, dev);
  await openParchiForVendor(page, {
    id: targetVendor.id,
    category: targetCategory.label,
  });
  await expect(page.getByTestId("parchi-payment-block")).not.toBeVisible();

  await seedBlockingBill({
    vendorId: blockVendor.id,
    message: `cpb-block-def-${T}`,
    userPhone: phone,
    deviceId: dev,
  });

  await expect(page.getByTestId("parchi-message-input")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("parchi-message-input").fill(`Defensive block test ${T}`);
  await page.getByTestId("parchi-address-input").fill(`Flat 1 Block Test ${T}`);
  await page.getByTestId("parchi-submit-btn").click();

  const inset = page.getByTestId("parchi-payment-block");
  await expect(inset).toBeVisible({ timeout: 20000 });
  await expect(inset).toContainText(blockShop);
  await expect(inset).toContainText("250");
});
