/**
 * Recurring Delivery/Scheduled arrangements spawn ordinary requests.
 * Help/ASAP are rejected. Pause/cancel stop further spawns. Khata untouched.
 */
import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdRequestIds: string[] = [];

test.setTimeout(90_000);

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("recurring_orders").delete().eq("vendor_id", id);
    await deleteVendorRegistrationArtifacts(id);
  }
});

async function seedDeliveryVendor() {
  const cat = await getActiveCategoryByServiceMode("delivery");
  const vendorPhone = `99041${String(T).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Recurring Delivery",
      shop_name: `!REC-${T}`,
      category: cat.label,
      service_mode: "delivery",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
      serves_at_vendor_place: true,
      serves_at_customer_place: true,
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  const vendorId = vendor!.id;
  createdVendorIds.push(vendorId);
  await seedVendorCategory(vendorId, { id: cat.id, service_mode: "delivery" }, {
    is_primary: true,
    modes: ["delivery"],
    serves_at_customer_place: true,
  });
  return { vendorId, cat };
}

test("RO-01 — daily recurring spawns instances; pause then cancel stop further orders", async () => {
  const { vendorId, cat } = await seedDeliveryVendor();
  const customerPhone = `88041${String(T).slice(-5)}`;
  const deviceId = `rec-${T}`;
  createdPhones.push(customerPhone);

  await supabaseAdmin.from("users").upsert(
    { phone: customerPhone, trust_score: 75 },
    { onConflict: "phone" },
  );

  const { data: firstId, error: createErr } = await supabase.rpc("create_recurring_order", {
    p_device_id: deviceId,
    p_vendor_id: vendorId,
    p_message: "Daily milk",
    p_interval_kind: "daily",
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_delivery_address: "Pune test",
    p_delivery_slot: "evening",
    p_delivery_slot_deadline: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    p_category_id: cat.id,
    p_service_mode: "delivery",
  });
  expect(createErr, createErr?.message).toBeNull();
  expect(firstId).toBeTruthy();
  createdRequestIds.push(firstId as string);

  const { data: firstReq } = await supabaseAdmin
    .from("requests")
    .select("id, recurring_order_id, status, service_mode")
    .eq("id", firstId as string)
    .single();
  expect(firstReq?.recurring_order_id).toBeTruthy();
  expect(firstReq?.service_mode).toBe("delivery");
  const parentId = firstReq!.recurring_order_id as string;

  const { data: listed } = await supabase.rpc("list_my_recurring_orders", {
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  expect(
    ((listed ?? []) as { id: string; status: string }[]).some(
      (r) => r.id === parentId && r.status === "active",
    ),
  ).toBe(true);

  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parentId);

  const { data: spawned, error: spawnErr } = await supabaseAdmin.rpc(
    "spawn_due_recurring_orders",
  );
  expect(spawnErr, spawnErr?.message).toBeNull();
  expect(Number(spawned)).toBeGreaterThanOrEqual(1);

  const { data: kids } = await supabaseAdmin
    .from("requests")
    .select("id")
    .eq("recurring_order_id", parentId);
  expect((kids ?? []).length).toBeGreaterThanOrEqual(2);
  for (const row of kids ?? []) createdRequestIds.push(row.id);

  const { error: pauseErr } = await supabase.rpc("customer_set_recurring_order_status", {
    p_recurring_order_id: parentId,
    p_status: "paused",
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  expect(pauseErr, pauseErr?.message).toBeNull();

  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parentId);

  const beforePause = (kids ?? []).length;
  await supabaseAdmin.rpc("spawn_due_recurring_orders");
  const { data: afterPause } = await supabaseAdmin
    .from("requests")
    .select("id")
    .eq("recurring_order_id", parentId);
  expect((afterPause ?? []).length).toBe(beforePause);

  const { error: cancelErr } = await supabase.rpc("customer_set_recurring_order_status", {
    p_recurring_order_id: parentId,
    p_status: "cancelled",
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  expect(cancelErr, cancelErr?.message).toBeNull();

  const { data: afterCancel } = await supabase.rpc("list_my_recurring_orders", {
    p_user_phone: customerPhone,
    p_device_id: deviceId,
  });
  expect(
    ((afterCancel ?? []) as { id: string }[]).some((r) => r.id === parentId),
  ).toBe(false);
});

test("RO-02 — Help-mode bookings cannot be made recurring", async () => {
  const cat = await getActiveCategoryByServiceMode("help");
  const vendorPhone = `99042${String(T).slice(-5)}`;
  const customerPhone = `88042${String(T).slice(-5)}`;
  createdPhones.push(customerPhone);

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Help Not Recurring",
      shop_name: `!REC-HELP-${T}`,
      category: cat.label,
      service_mode: "help",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, cat, { is_primary: true, modes: ["help"] });

  const { data, error: recErr } = await supabase.rpc("create_recurring_order", {
    p_device_id: `rec-help-${T}`,
    p_vendor_id: vendor!.id,
    p_message: "Urgent leak",
    p_interval_kind: "daily",
    p_user_phone: customerPhone,
    p_service_mode: "help",
    p_category_id: cat.id,
  });
  expect(data).toBeNull();
  expect(recErr?.message ?? "").toMatch(/recurrence_mode_not_allowed/);
});
