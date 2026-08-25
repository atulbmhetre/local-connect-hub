/**
 * Scheduled-deletion vendors must be hidden from new Radar discovery and new
 * booking, while remaining visible on order-history / tracking RPCs.
 */
import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdRequestIds: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
});

test("RAD-DEL-01 — scheduled-deletion vendor excluded from radar and new booking; order history still visible", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");
  const vendorPhone = `99017${String(T).slice(-5)}`;
  const customerPhone = `88017${String(T).slice(-5)}`;
  const customerDevice = `rad-del-${T}`;
  createdPhones.push(customerPhone);

  const { data: vendor, error: insErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Scheduled Deletion Radar",
      shop_name: `!RAD-DEL-${T}`,
      category: cat.label,
      service_mode: cat.service_mode,
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
  expect(insErr).toBeNull();
  const vendorId = vendor!.id;
  createdVendorIds.push(vendorId);

  await seedVendorCategory(vendorId, cat, {
    is_primary: true,
    modes: ["help", "delivery"],
  });

  await supabaseAdmin.from("users").upsert(
    { phone: customerPhone, trust_score: 75 },
    { onConflict: "phone" },
  );

  const { data: priorOrder, error: priorErr } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: customerDevice,
      vendor_id: vendorId,
      message: "RAD-DEL prior order",
      user_phone: customerPhone,
      status: "done",
      category_id: cat.id,
      service_mode: String(cat.service_mode ?? "help").toLowerCase(),
    })
    .select("id")
    .single();
  expect(priorErr, priorErr?.message).toBeNull();
  createdRequestIds.push(priorOrder!.id);

  const mode = String(cat.service_mode ?? "help").toLowerCase();
  const { data: before, error: beforeErr } = await supabase.rpc(
    "get_radar_category_mode_matches",
    { p_mode: mode, p_category_ids: [cat.id] },
  );
  expect(beforeErr).toBeNull();
  expect(
    ((before ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);

  const { error: delErr } = await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", vendorId);
  expect(delErr).toBeNull();

  const { data: hidden, error: hideErr } = await supabase.rpc(
    "get_radar_category_mode_matches",
    { p_mode: mode, p_category_ids: [cat.id] },
  );
  expect(hideErr).toBeNull();
  expect(
    ((hidden ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(false);

  const { data: rlsRow, error: rlsErr } = await supabase
    .from("vendors")
    .select("id")
    .eq("id", vendorId)
    .maybeSingle();
  expect(rlsErr).toBeNull();
  expect(rlsRow).toBeNull();

  const { data: newOrderId, error: bookErr } = await supabaseAdmin.rpc(
    "create_customer_request",
    {
      p_device_id: customerDevice,
      p_vendor_id: vendorId,
      p_message: "RAD-DEL new booking should fail",
      p_user_phone: customerPhone,
      p_device_id_log: customerDevice,
      p_category_id: cat.id,
      p_service_mode: mode,
    },
  );
  expect(newOrderId).toBeFalsy();
  expect(bookErr?.message ?? "").toContain("vendor_not_discoverable");

  const { data: history, error: histErr } = await supabase.rpc(
    "get_vendors_visible_to_customer",
    {
      p_vendor_ids: [vendorId],
      p_user_phone: customerPhone,
      p_device_id: customerDevice,
    },
  );
  expect(histErr, histErr?.message).toBeNull();
  expect(
    ((history ?? []) as { id: string }[]).some((row) => row.id === vendorId),
  ).toBe(true);

  const { error: restoreErr } = await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: null })
    .eq("id", vendorId);
  expect(restoreErr).toBeNull();

  const { data: after, error: afterErr } = await supabase.rpc(
    "get_radar_category_mode_matches",
    { p_mode: mode, p_category_ids: [cat.id] },
  );
  expect(afterErr).toBeNull();
  expect(
    ((after ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);
});
