/**
 * pending_location_review must be hidden from Radar until admin approves.
 */
import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";
import { ensureTestAdminUser, getAdminSessionClient } from "./helpers/browser-setup";

const T = Date.now();
const createdVendorIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
});

test("RAD-LOC-01 — pending_location_review excluded from radar until admin_verify", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");
  const phone = `99007${String(T).slice(-5)}`;

  const { data: vendor, error: insErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone,
      name: "Loc Review Radar",
      shop_name: `!RAD-LOC-${T}`,
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

  await supabaseAdmin
    .from("vendor_categories")
    .update({
      verification_status: "pending_location_review",
      gps_match_distance: 500,
      is_manual_verified: false,
    })
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id);

  const mode = String(cat.service_mode ?? "help").toLowerCase();
  const { data: hidden, error: hideErr } = await supabase.rpc(
    "get_radar_category_mode_matches",
    { p_mode: mode, p_category_ids: [cat.id] },
  );
  expect(hideErr).toBeNull();
  expect(
    ((hidden ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(false);

  await ensureTestAdminUser();
  const adminClient = await getAdminSessionClient();
  const { error: verifyErr } = await adminClient.rpc("admin_verify_vendor_category", {
    p_admin_phone: "8888169446",
    p_vendor_id: vendorId,
    p_category_id: cat.id,
  });
  expect(verifyErr, verifyErr?.message).toBeNull();

  const { data: after, error: afterErr } = await supabase.rpc(
    "get_radar_category_mode_matches",
    { p_mode: mode, p_category_ids: [cat.id] },
  );
  expect(afterErr).toBeNull();
  expect(
    ((after ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);

  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("verification_status, is_manual_verified, status")
    .eq("vendor_id", vendorId)
    .eq("category_id", cat.id)
    .single();
  expect(vc?.status).toBe("approved");
  expect(vc?.verification_status).toBe("business_verified");
  expect(vc?.is_manual_verified).toBe(true);
});

test("RAD-LOC-02 — get_admin_green_pending_stats counts pending_location_review", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");
  const phone = `99008${String(T + 1).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone,
      name: "Loc Review Stats",
      shop_name: `!RAD-LOC-STATS-${T}`,
      category: cat.label,
      service_mode: "help",
      is_active: false,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 15,
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  createdVendorIds.push(vendor!.id);

  await seedVendorCategory(vendor!.id, cat, { is_primary: true, modes: ["help"] });
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      verification_status: "pending_location_review",
      is_manual_verified: false,
    })
    .eq("vendor_id", vendor!.id);

  await ensureTestAdminUser();
  const adminClient = await getAdminSessionClient();
  const { data, error: statsErr } = await adminClient.rpc("get_admin_green_pending_stats");
  expect(statsErr).toBeNull();
  const stats = data as { category_pending: number; vendors_ready: number };
  expect(stats.category_pending).toBeGreaterThanOrEqual(1);
  expect(stats.vendors_ready).toBeGreaterThanOrEqual(1);
});
