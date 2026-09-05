import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_VENDOR_SHOP_PHOTO,
} from "./helpers/setup";

const T = Date.now();
const CUSTOMER_PHONE = `88041${String(T).slice(-5)}`;
const DEVICE_ID = `device_idem_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_menu_items").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_verification").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
  await supabaseAdmin.from("users").delete().eq("phone", CUSTOMER_PHONE);
});

test("IDEMP — lost response + retry returns same request, only one row", async () => {
  test.setTimeout(60_000);
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const shopName = `!IDEMP-${T}`;
  const idemKey = crypto.randomUUID();

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Idempotency Owner",
      shop_name: shopName,
      phone: `99041${String(T).slice(-5)}`,
      category: grocery.label,
      service_mode: "delivery",
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: "complete",
      discoverable: true,
      subscription_status: "active",
      service_radius_km: 9999,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, grocery, {
    is_primary: true,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    service_radius_km: 9999,
    modes: ["delivery"],
  });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from("vendors")
    .update({ discoverable: true, subscription_status: "active" })
    .eq("id", vendor.id);
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: "business_verified",
      service_radius_km: 9999,
    })
    .eq("vendor_id", vendor.id)
    .eq("category_id", grocery.id);

  await supabaseAdmin
    .from("users")
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: "phone" });

  const payload = {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendor.id,
    p_message: `idem lost-response ${T}`,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Idempotency test address",
    p_delivery_slot: "tomorrow",
    p_client_idempotency_key: idemKey,
  };

  // First call succeeds (server wrote the row). Client "loses" the response.
  const first = await supabase.rpc("create_customer_request", payload);
  expect(first.error, `first place: ${first.error?.message}`).toBeNull();
  expect(first.data).toBeTruthy();
  createdRequestIds.push(first.data as string);

  // Retry with the same key (lost-response + retry) — must return same id.
  const retry = await supabase.rpc("create_customer_request", payload);
  expect(retry.error, `retry: ${retry.error?.message}`).toBeNull();
  expect(retry.data).toBe(first.data);

  const { data: rows, error: countErr } = await supabaseAdmin
    .from("requests")
    .select("id")
    .eq("client_idempotency_key", idemKey);
  expect(countErr).toBeNull();
  expect(rows?.length, "exactly one order for idempotency key").toBe(1);
  expect(rows?.[0]?.id).toBe(first.data);

  // A different key still creates a second order.
  const secondKey = crypto.randomUUID();
  const other = await supabase.rpc("create_customer_request", {
    ...payload,
    p_message: `idem other key ${T}`,
    p_client_idempotency_key: secondKey,
  });
  expect(other.error, `other key: ${other.error?.message}`).toBeNull();
  expect(other.data).toBeTruthy();
  expect(other.data).not.toBe(first.data);
  createdRequestIds.push(other.data as string);
});
