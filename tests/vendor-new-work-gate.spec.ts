/**
 * Phase 5: vendor_business_new_work_block — same NEW-work rules on radar,
 * resolve, and create_customer_request. History RPC stays unfiltered.
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
    await deleteVendorRegistrationArtifacts(id);
  }
});

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedLive(shop: string) {
  const cat = await getActiveCategoryByServiceMode("help");
  const vendorPhone = nextPhone("99075");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "New Work Gate Vendor",
      shop_name: shop,
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
      subscription_status: "trial",
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, cat, { is_primary: true, modes: ["help"] });
  return { vendorId: vendor!.id, cat, mode: "help" as const };
}

async function onRadar(vendorId: string, categoryId: string, mode: string) {
  const { data, error } = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: mode,
    p_category_ids: [categoryId],
  });
  expect(error, error?.message).toBeNull();
  return ((data ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId);
}

async function resolveHint(vendorId: string, categoryId: string, mode: string) {
  return supabaseAdmin.rpc("_resolve_booking_category", {
    p_vendor_id: vendorId,
    p_hint_category_id: categoryId,
    p_hint_service_mode: mode,
  });
}

async function book(vendorId: string, categoryId: string, mode: string) {
  const customerPhone = nextPhone("88075");
  const device = `nwg-${T}-${createdPhones.length}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  return supabaseAdmin.rpc("create_customer_request", {
    p_device_id: device,
    p_vendor_id: vendorId,
    p_message: "new-work-gate",
    p_user_phone: customerPhone,
    p_device_id_log: device,
    p_category_id: categoryId,
    p_service_mode: mode,
  });
}

async function historyVisible(vendorId: string, customerPhone: string, device: string) {
  const { data, error } = await supabase.rpc("get_vendors_visible_to_customer", {
    p_vendor_ids: [vendorId],
    p_user_phone: customerPhone,
    p_device_id: device,
  });
  expect(error, error?.message).toBeNull();
  return ((data ?? []) as { id: string }[]).some((row) => row.id === vendorId);
}

test("GATE-HELPER — block codes: null / paused / location / deletion; ignores is_active and subscription", async () => {
  const { vendorId, cat } = await seedLive(`!NWG-HELPER-${T}`);
  const { data: ok } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(ok).toBeNull();

  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);
  const { data: paused } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(paused).toBe("vendor_not_discoverable");

  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: false, verification_status: "pending_location_review" })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);
  const { data: loc } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(loc).toBe("category_location_review_pending");

  await supabaseAdmin
    .from("vendor_categories")
    .update({ verification_status: "identity_linked" })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);
  await supabaseAdmin
    .from("vendors")
    .update({
      deletion_requested_at: new Date().toISOString(),
      is_active: false,
      subscription_status: "expired",
    })
    .eq("id", vendorId);
  const { data: del } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(del).toBe("vendor_deletion_scheduled");

  await supabaseAdmin.from("vendors").update({ deletion_requested_at: null }).eq("id", vendorId);
  const { data: stillOk } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(stillOk).toBeNull();
});

test("GATE-PAUSE — radar hide, resolve + booking vendor_not_discoverable, history visible", async () => {
  const { vendorId, cat, mode } = await seedLive(`!NWG-PAUSE-${T}`);
  const customerPhone = nextPhone("88076");
  const device = `nwg-pause-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data: prior } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: device,
      vendor_id: vendorId,
      message: "prior",
      user_phone: customerPhone,
      status: "done",
      category_id: cat.id,
      service_mode: mode,
    })
    .select("id")
    .single();
  createdRequestIds.push(prior!.id);

  expect(await onRadar(vendorId, cat.id, mode)).toBe(true);
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);

  expect(await onRadar(vendorId, cat.id, mode)).toBe(false);
  const resolved = await resolveHint(vendorId, cat.id, mode);
  expect(resolved.error?.message ?? "").toMatch(/vendor_not_discoverable/);
  const placed = await book(vendorId, cat.id, mode);
  expect(placed.error?.message ?? "").toMatch(/vendor_not_discoverable/);
  expect(await historyVisible(vendorId, customerPhone, device)).toBe(true);
});

test("GATE-LOC — radar hide, resolve + booking category_location_review_pending, history visible", async () => {
  const { vendorId, cat, mode } = await seedLive(`!NWG-LOC-${T}`);
  const customerPhone = nextPhone("88077");
  const device = `nwg-loc-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data: prior } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: device,
      vendor_id: vendorId,
      message: "prior-loc",
      user_phone: customerPhone,
      status: "done",
      category_id: cat.id,
      service_mode: mode,
    })
    .select("id")
    .single();
  createdRequestIds.push(prior!.id);

  await supabaseAdmin
    .from("vendor_categories")
    .update({ verification_status: "pending_location_review" })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);

  expect(await onRadar(vendorId, cat.id, mode)).toBe(false);
  const resolved = await resolveHint(vendorId, cat.id, mode);
  expect(resolved.error?.message ?? "").toMatch(/category_location_review_pending/);
  const placed = await book(vendorId, cat.id, mode);
  expect(placed.error?.message ?? "").toMatch(/category_location_review_pending/);
  expect(await historyVisible(vendorId, customerPhone, device)).toBe(true);
});

test("GATE-DEL — radar hide, resolve + booking vendor_deletion_scheduled, history visible", async () => {
  const { vendorId, cat, mode } = await seedLive(`!NWG-DEL-${T}`);
  const customerPhone = nextPhone("88078");
  const device = `nwg-del-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data: prior } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: device,
      vendor_id: vendorId,
      message: "prior-del",
      user_phone: customerPhone,
      status: "done",
      category_id: cat.id,
      service_mode: mode,
    })
    .select("id")
    .single();
  createdRequestIds.push(prior!.id);

  await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", vendorId);

  expect(await onRadar(vendorId, cat.id, mode)).toBe(false);
  const resolved = await resolveHint(vendorId, cat.id, mode);
  expect(resolved.error?.message ?? "").toMatch(/vendor_deletion_scheduled/);
  const placed = await book(vendorId, cat.id, mode);
  expect(placed.error?.message ?? "").toMatch(/vendor_deletion_scheduled/);
  expect(placed.error?.message ?? "").not.toMatch(/vendor_not_discoverable/);
  expect(await historyVisible(vendorId, customerPhone, device)).toBe(true);
});

test("GATE-NO-SUB-ACTIVE — offline + expired subscription still take NEW work on all three surfaces", async () => {
  const { vendorId, cat, mode } = await seedLive(`!NWG-OFFLINE-${T}`);
  await supabaseAdmin
    .from("vendors")
    .update({ is_active: false, subscription_status: "expired" })
    .eq("id", vendorId);

  expect(await onRadar(vendorId, cat.id, mode)).toBe(true);
  const resolved = await resolveHint(vendorId, cat.id, mode);
  expect(resolved.error, resolved.error?.message).toBeNull();
  const placed = await book(vendorId, cat.id, mode);
  expect(placed.error, placed.error?.message).toBeNull();
  expect(placed.data).toBeTruthy();
  createdRequestIds.push(placed.data as string);
});
