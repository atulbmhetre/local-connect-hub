/**
 * Deletion-grace product behavior:
 * - Vendor scheduled for deletion: new booking rejected (vendor_deletion_scheduled);
 *   existing accepted order can still be fulfilled.
 * - Customer scheduled for deletion: open orders cancelled; new booking rejected;
 *   khata-outstanding vendors get a distinct notification.
 */
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
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("order_bills").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("khata_ledger").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("user_devices").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_verification").delete().eq("vendor_id", id);
    const { data: v } = await supabaseAdmin.from("vendors").select("phone").eq("id", id).maybeSingle();
    if (v?.phone) {
      await supabaseAdmin.from("user_notifications").delete().eq("user_phone", v.phone);
    }
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
});

async function seedLiveDeliveryVendor(tag: string) {
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const phone = tag === "V" ? `99053${String(T).slice(-5)}` : `99054${String(T).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `DelGrace ${tag}`,
      shop_name: `!DEL-GRACE-${tag}-${T}`,
      phone,
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
    .select("id, phone")
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
  return { vendor, grocery };
}

test("DEL-GRACE-VENDOR — new booking rejected; existing order still acceptable", async () => {
  test.setTimeout(60_000);
  const { vendor, grocery } = await seedLiveDeliveryVendor("V");
  const customerPhone = `88051${String(T).slice(-5)}`;
  const deviceId = `del_grace_v_${T}`;
  createdPhones.push(customerPhone);
  await supabaseAdmin
    .from("users")
    .upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });

  const place = await supabase.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: `pre-deletion order ${T}`,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Grace vendor test",
    p_delivery_slot: "tomorrow",
  });
  expect(place.error, place.error?.message).toBeNull();
  const requestId = place.data as string;
  createdRequestIds.push(requestId);

  await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", vendor.id);

  const blocked = await supabase.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: `should fail ${T}`,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Grace vendor test",
    p_delivery_slot: "tomorrow",
  });
  expect(blocked.data).toBeFalsy();
  expect(blocked.error?.message ?? "").toContain("vendor_deletion_scheduled");

  // Existing obligation: accept the pre-deletion order while vendor is in grace.
  const { error: acceptErr } = await supabase.rpc("vendor_accept_order", {
    p_request_id: requestId,
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_from_status: "sent",
  });
  expect(acceptErr, acceptErr?.message).toBeNull();
  const { data: row } = await supabaseAdmin
    .from("requests")
    .select("status")
    .eq("id", requestId)
    .single();
  expect(row?.status).toBe("accepted");
});

test("DEL-GRACE-CUSTOMER — open orders cancelled, place blocked, khata vendor notified", async () => {
  test.setTimeout(90_000);
  const { vendor, grocery } = await seedLiveDeliveryVendor("C");
  const customerPhone = `88052${String(T).slice(-5)}`;
  const deviceId = `del_grace_c_${T}`;
  createdPhones.push(customerPhone);
  createdPhones.push(vendor.phone);

  await supabaseAdmin
    .from("users")
    .upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  await supabaseAdmin.from("user_devices").delete().eq("device_id", deviceId);
  const { error: deviceErr } = await supabaseAdmin.from("user_devices").insert({
    user_phone: customerPhone,
    device_id: deviceId,
    fcm_token: `fcm_${customerPhone}`,
  });
  expect(deviceErr, deviceErr?.message).toBeNull();

  const open = await supabase.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: `open before delete ${T}`,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Grace customer test",
    p_delivery_slot: "tomorrow",
  });
  expect(open.error, open.error?.message).toBeNull();
  const openId = open.data as string;
  createdRequestIds.push(openId);

  const accepted = await supabase.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: `accepted before delete ${T}`,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Grace customer test",
    p_delivery_slot: "morning",
  });
  expect(accepted.error, accepted.error?.message).toBeNull();
  const acceptedId = accepted.data as string;
  createdRequestIds.push(acceptedId);
  await supabaseAdmin.from("requests").update({ status: "accepted" }).eq("id", acceptedId);

  await supabaseAdmin.from("khata_ledger").delete().eq("vendor_id", vendor.id).eq("user_phone", customerPhone);
  const { error: khataInsErr } = await supabaseAdmin.from("khata_ledger").insert({
    vendor_id: vendor.id,
    user_phone: customerPhone,
    total_outstanding: 250,
    last_updated: new Date().toISOString(),
  });
  expect(khataInsErr, khataInsErr?.message).toBeNull();

  await supabaseAdmin
    .from("users")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("phone", customerPhone);

  const { data: finalize, error: finErr } = await supabaseAdmin.rpc(
    "finalize_customer_deletion_request",
    { p_phone: customerPhone },
  );
  expect(finErr, finErr?.message).toBeNull();
  expect(finalize?.cancelled_orders).toBeGreaterThanOrEqual(2);
  expect(finalize?.khata_vendors_notified).toBeGreaterThanOrEqual(1);

  const { data: openRow } = await supabaseAdmin
    .from("requests")
    .select("status")
    .eq("id", openId)
    .single();
  const { data: acceptedRow } = await supabaseAdmin
    .from("requests")
    .select("status")
    .eq("id", acceptedId)
    .single();
  expect(openRow?.status).toBe("cancelled");
  expect(acceptedRow?.status).toBe("cancelled");

  const blocked = await supabase.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: `after delete ${T}`,
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "Grace customer test",
    p_delivery_slot: "tomorrow",
  });
  expect(blocked.data).toBeFalsy();
  expect(blocked.error?.message ?? "").toContain("customer_deletion_scheduled");

  const { data: khataNotifs } = await supabaseAdmin
    .from("user_notifications")
    .select("type, title, body")
    .eq("user_phone", vendor.phone)
    .eq("type", "account_deletion_khata");
  expect((khataNotifs ?? []).length).toBeGreaterThanOrEqual(1);
  expect(khataNotifs?.[0]?.body ?? "").toMatch(/250|Khata|ख़ाता|खात/i);

  const { data: cancelNotifs } = await supabaseAdmin
    .from("user_notifications")
    .select("type, title")
    .eq("user_phone", vendor.phone)
    .eq("type", "order_update");
  expect((cancelNotifs ?? []).length).toBeGreaterThanOrEqual(1);
});
