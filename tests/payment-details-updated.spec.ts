/**
 * Pay-screen transparency: billed_* freeze at UPI bill create; live UPI / QR /
 * mobile ({vendors.phone}@upi) can change later; one shared notice.
 */
import { test, expect } from "@playwright/test";
import { loginAsCustomer, APP_URL } from "./helpers/browser-setup";
import {
  supabaseAdmin,
  vendorPhoneById,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";

const T = Date.now();
const CUSTOMER_PHONE = `88006${String(T).slice(-5)}`;
const DEVICE_ID = `device_paydest_${T}`;
const ORIGINAL_UPI = `paydest-orig-${T}@upi`;
const NEW_UPI = `paydest-new-${T}@upi`;
const ORIGINAL_QR = `https://example.com/qr-orig-${T}.png`;
const NEW_QR = `https://example.com/qr-new-${T}.png`;
const NEW_PHONE = `99006${String(T).slice(-5)}`;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("order_items").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("order_bills").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  await supabaseAdmin.from("users").delete().eq("phone", CUSTOMER_PHONE);
});

test("PAY-DEST-01 — change UPI, QR, and mobile after bill; Pay shows update + one notice", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const category = await getActiveCategoryByServiceMode("delivery");
  const originalPhone = `99005${String(T).slice(-5)}`;
  const { data: vendor, error: vendorErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `PayDest ${T}`,
      shop_name: `!PAY-DEST-${T}`,
      phone: originalPhone,
      upi_id: ORIGINAL_UPI,
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
  expect(vendorErr, vendorErr?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, category, {
    upi_id: ORIGINAL_UPI,
    upi_qr_url: ORIGINAL_QR,
    upi_qr_payee_id: ORIGINAL_UPI,
  });

  const { error: userErr } = await supabaseAdmin
    .from("users")
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: "phone" });
  expect(userErr, userErr?.message).toBeNull();

  const msg = `PAY-DEST-01 ${T}`;
  const { data: request, error: reqErr } = await supabaseAdmin
    .from("requests")
    .insert({
      vendor_id: vendor!.id,
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_ID,
      message: msg,
      status: "fulfilled",
      payment_status: "unpaid",
      service_mode: "delivery",
      category_id: category.id,
      delivery_slot: "morning",
      delivery_fulfillment_method: "agent",
      delivery_payment_timing: "prepaid",
    })
    .select("id")
    .single();
  expect(reqErr, reqErr?.message).toBeNull();
  createdRequestIds.push(request!.id);

  const { error: billErr } = await supabaseAdmin.rpc("insert_bill_with_items", {
    p_order_id: request!.id,
    p_vendor_id: vendor!.id,
    p_vendor_phone: await vendorPhoneById(vendor!.id),
    p_customer_phone: CUSTOMER_PHONE,
    p_total: 250,
    p_payment_mode: "upi",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: [{ name: "PayDest item", quantity: 1, unit_price: 250, unit: null }],
  });
  expect(billErr, billErr?.message).toBeNull();

  const { data: afterBill } = await supabaseAdmin
    .from("requests")
    .select(
      "billed_upi_id, billed_upi_qr_url, billed_upi_payee_id, billed_payment_phone, billed_payment_snapshot_at, intended_upi_id",
    )
    .eq("id", request!.id)
    .single();
  expect(afterBill?.billed_payment_snapshot_at).toBeTruthy();
  expect(afterBill?.billed_upi_id).toBe(ORIGINAL_UPI);
  expect(afterBill?.billed_upi_qr_url).toBe(ORIGINAL_QR);
  expect(afterBill?.billed_upi_payee_id).toBe(ORIGINAL_UPI);
  expect(afterBill?.billed_payment_phone).toBe(originalPhone);
  expect(afterBill?.intended_upi_id).toBe(ORIGINAL_UPI);

  const { error: upiErr } = await supabaseAdmin
    .from("vendor_categories")
    .update({
      upi_id: NEW_UPI,
      upi_qr_url: NEW_QR,
      upi_qr_payee_id: NEW_UPI,
    })
    .eq("vendor_id", vendor!.id)
    .eq("category_id", category.id);
  expect(upiErr, upiErr?.message).toBeNull();

  const { error: phoneErr } = await supabaseAdmin
    .from("vendors")
    .update({ phone: NEW_PHONE })
    .eq("id", vendor!.id);
  expect(phoneErr, phoneErr?.message).toBeNull();

  const { error: sheetSnapErr } = await supabaseAdmin.rpc("snapshot_intended_upi_payee", {
    p_request_id: request!.id,
    p_device_id: DEVICE_ID,
    p_user_phone: CUSTOMER_PHONE,
  });
  expect(sheetSnapErr, sheetSnapErr?.message).toBeNull();

  const { data: afterChange } = await supabaseAdmin
    .from("requests")
    .select(
      "billed_upi_id, billed_upi_qr_url, billed_upi_payee_id, billed_payment_phone, intended_upi_id, intended_upi_qr_url, intended_upi_payee_id",
    )
    .eq("id", request!.id)
    .single();
  expect(afterChange?.intended_upi_id).toBe(NEW_UPI);
  expect(afterChange?.intended_upi_qr_url).toBe(NEW_QR);
  expect(afterChange?.intended_upi_payee_id).toBe(NEW_UPI);
  expect(afterChange?.billed_upi_id).toBe(ORIGINAL_UPI);
  expect(afterChange?.billed_upi_qr_url).toBe(ORIGINAL_QR);
  expect(afterChange?.billed_payment_phone).toBe(originalPhone);

  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/my-orders`);
  await expect(page.getByTestId("my-orders-screen")).toBeVisible({ timeout: 20000 });
  const card = page.getByTestId("order-card").filter({ hasText: msg });
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.getByTestId("my-orders-pay-now-btn").click();
  const sheet = page.getByTestId("payment-sheet");
  await expect(sheet).toBeVisible({ timeout: 10000 });

  await expect(sheet.getByTestId("payment-sheet-payment-details-updated")).toBeVisible();
  await expect(sheet.getByTestId("payment-sheet-payment-details-updated")).toHaveText(
    "Payment details were updated by the vendor. The QR code has also changed.",
  );
  await expect(sheet.getByTestId("payment-sheet-upi-id")).toHaveText(NEW_UPI);

  await sheet.getByRole("button", { name: "Mobile" }).click();
  await expect(sheet.getByTestId("payment-sheet-mobile")).toHaveText(NEW_PHONE);

  await sheet.getByRole("button", { name: "QR Code" }).click();
  await expect(sheet.getByTestId("payment-sheet-qr-image")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Pay Now" })).toBeVisible();

  await expect(sheet.getByTestId("payment-sheet-payment-details-updated")).toHaveCount(1);
});
