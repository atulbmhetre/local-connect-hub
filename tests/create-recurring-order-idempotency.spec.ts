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
const CUSTOMER_PHONE = `88042${String(T).slice(-5)}`;
const DEVICE_ID = `device_rec_idem_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdRecurringIds: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdRecurringIds.length) {
    await supabaseAdmin.from("recurring_orders").delete().in("id", createdRecurringIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_menu_items").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_verification").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
  await supabaseAdmin.from("users").delete().eq("phone", CUSTOMER_PHONE);
});

test("IDEMP-RECURRING — lost response + retry returns same child, one parent + one request", async () => {
  test.setTimeout(60_000);
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const shopName = `!IDEMP-REC-${T}`;
  const idemKey = crypto.randomUUID();

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Recurring Idem Owner",
      shop_name: shopName,
      phone: `99042${String(T).slice(-5)}`,
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
    p_message: `recurring idem lost-response ${T}`,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Recurring idempotency test address",
    p_delivery_slot: "morning",
    p_interval_kind: "daily",
    p_interval_days: null,
    p_client_idempotency_key: idemKey,
  };

  const first = await supabase.rpc("create_recurring_order", payload);
  expect(first.error, `first recurring place: ${first.error?.message}`).toBeNull();
  expect(first.data).toBeTruthy();
  createdRequestIds.push(first.data as string);

  const retry = await supabase.rpc("create_recurring_order", payload);
  expect(retry.error, `retry: ${retry.error?.message}`).toBeNull();
  expect(retry.data).toBe(first.data);

  const { data: parents, error: parentErr } = await supabaseAdmin
    .from("recurring_orders")
    .select("id, last_request_id")
    .eq("client_idempotency_key", idemKey);
  expect(parentErr).toBeNull();
  expect(parents?.length, "exactly one recurring parent for idempotency key").toBe(1);
  expect(parents?.[0]?.last_request_id).toBe(first.data);
  if (parents?.[0]?.id) createdRecurringIds.push(parents[0].id);

  const { data: rows, error: countErr } = await supabaseAdmin
    .from("requests")
    .select("id, recurring_order_id")
    .eq("client_idempotency_key", idemKey);
  expect(countErr).toBeNull();
  expect(rows?.length, "exactly one child request for idempotency key").toBe(1);
  expect(rows?.[0]?.id).toBe(first.data);
  expect(rows?.[0]?.recurring_order_id).toBe(parents?.[0]?.id);

  const secondKey = crypto.randomUUID();
  const other = await supabase.rpc("create_recurring_order", {
    ...payload,
    p_message: `recurring idem other key ${T}`,
    p_client_idempotency_key: secondKey,
  });
  expect(other.error, `other key: ${other.error?.message}`).toBeNull();
  expect(other.data).toBeTruthy();
  expect(other.data).not.toBe(first.data);
  createdRequestIds.push(other.data as string);

  const { data: otherParents } = await supabaseAdmin
    .from("recurring_orders")
    .select("id")
    .eq("client_idempotency_key", secondKey);
  if (otherParents?.[0]?.id) createdRecurringIds.push(otherParents[0].id);
});
