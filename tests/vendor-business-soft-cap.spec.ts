/**
 * 6th+ vendor business is saved as pending_review, hidden from discovery/booking,
 * and goes live only after admin approve.
 */
import { test, expect } from "@playwright/test";
import { ensureTestAdminUser, getAdminSessionClient } from "./helpers/browser-setup";
import {
  supabase,
  supabaseAdmin,
  getActiveCategories,
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

async function seedVendorThroughSixth(tag: string) {
  const cats = await getActiveCategories(6);
  expect(cats.length, "TEST needs at least 6 active categories").toBeGreaterThanOrEqual(6);

  const vendorPhone = `99031${String(T).slice(-4)}${tag}`.slice(0, 10);
  const { data: vendor, error: insErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Soft Cap Owner",
      shop_name: `!VBC-${tag}-${T}`,
      category: cats[0].label,
      service_mode: cats[0].service_mode,
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
  expect(insErr, insErr?.message).toBeNull();
  const vendorId = vendor!.id;
  createdVendorIds.push(vendorId);

  for (let i = 0; i < 5; i += 1) {
    await seedVendorCategory(vendorId, cats[i], {
      is_primary: i === 0,
      modes: [String(cats[i].service_mode ?? "help").toLowerCase()],
    });
  }

  const ids = cats.slice(0, 6).map((c) => c.id);
  const modesById = Object.fromEntries(
    cats.slice(0, 6).map((c) => [c.id, [String(c.service_mode ?? "help").toLowerCase()]]),
  );
  const { error: addErr } = await supabaseAdmin.rpc("vendor_update_categories", {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_category_ids: ids,
    p_category_service_modes: cats
      .slice(0, 6)
      .map((c) => String(c.service_mode ?? "help").toLowerCase()),
    p_category_modes: modesById,
    p_serves_at_vendor_place: ids.map(() => true),
    p_serves_at_customer_place: ids.map(() => true),
    p_service_radius_km: ids.map(() => 15),
  });
  expect(addErr, addErr?.message).toBeNull();

  const { data: rows } = await supabaseAdmin
    .from("vendor_categories")
    .select("id, category_id, status")
    .eq("vendor_id", vendorId);
  const byCat = new Map((rows ?? []).map((r) => [r.category_id, r]));
  for (let i = 0; i < 5; i += 1) {
    expect(byCat.get(cats[i].id)?.status, `business ${i + 1} should be live`).toBe("approved");
  }
  expect(byCat.get(cats[5].id)?.status).toBe("pending_review");

  return {
    vendorId,
    vendorPhone,
    cats,
    sixthVcId: byCat.get(cats[5].id)!.id,
  };
}

test("VBC-01 — 6th business pending, not discoverable; admin approve goes live", async () => {
  const { vendorId, cats } = await seedVendorThroughSixth("1");
  const sixthMode = String(cats[5].service_mode ?? "help").toLowerCase();
  const customerPhone = `88031${String(T).slice(-5)}`;
  const customerDevice = `vbc-${T}`;
  createdPhones.push(customerPhone);

  const { data: radarHidden } = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: sixthMode,
    p_category_ids: [cats[5].id],
  });
  expect(
    ((radarHidden ?? []) as { vendor_id: string; category_id: string }[]).some(
      (r) => r.vendor_id === vendorId && r.category_id === cats[5].id,
    ),
  ).toBe(false);

  const { data: vcPublic } = await supabase
    .from("vendor_categories")
    .select("id")
    .eq("vendor_id", vendorId)
    .eq("category_id", cats[5].id)
    .maybeSingle();
  expect(vcPublic).toBeNull();

  const firstMode = String(cats[0].service_mode ?? "help").toLowerCase();
  const { data: radarLive } = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: firstMode,
    p_category_ids: [cats[0].id],
  });
  expect(
    ((radarLive ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);

  await supabaseAdmin.from("users").upsert(
    { phone: customerPhone, trust_score: 75 },
    { onConflict: "phone" },
  );

  const { data: newOrderId, error: bookErr } = await supabaseAdmin.rpc(
    "create_customer_request",
    {
      p_device_id: customerDevice,
      p_vendor_id: vendorId,
      p_message: "VBC sixth should fail",
      p_user_phone: customerPhone,
      p_device_id_log: customerDevice,
      p_category_id: cats[5].id,
      p_service_mode: sixthMode,
    },
  );
  expect(newOrderId).toBeNull();
  expect(bookErr?.message ?? "").toMatch(/vendor_not_discoverable/);

  await ensureTestAdminUser();
  const admin = await getAdminSessionClient();
  const listed = await admin.rpc("admin_list_pending_vendor_businesses");
  expect(listed.error, listed.error?.message).toBeNull();
  const pending = (
    (listed.data ?? []) as { vendor_category_id: string; vendor_id: string; category_id: string }[]
  ).find((r) => r.vendor_id === vendorId && r.category_id === cats[5].id);
  expect(pending, "6th business should appear in admin pending list").toBeTruthy();
  expect(Array.isArray((pending as { approved_businesses?: unknown }).approved_businesses)).toBe(
    true,
  );

  const approved = await admin.rpc("admin_approve_vendor_business", {
    p_admin_phone: "admin",
    p_vendor_category_id: pending!.vendor_category_id,
  });
  expect(approved.error, approved.error?.message).toBeNull();

  const { data: after } = await supabaseAdmin
    .from("vendor_categories")
    .select("status")
    .eq("vendor_id", vendorId)
    .eq("category_id", cats[5].id)
    .single();
  expect(after?.status).toBe("approved");

  const { data: radarAfter } = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: sixthMode,
    p_category_ids: [cats[5].id],
  });
  expect(
    ((radarAfter ?? []) as { vendor_id: string; category_id: string }[]).some(
      (r) => r.vendor_id === vendorId && r.category_id === cats[5].id,
    ),
  ).toBe(true);
});

test("VBC-02 — admin reject keeps 6th off Radar and records the reason", async () => {
  const { vendorId, cats, sixthVcId } = await seedVendorThroughSixth("2");
  const reason = "Looks like duplicate / abuse check";

  await ensureTestAdminUser();
  const admin = await getAdminSessionClient();
  const rejected = await admin.rpc("admin_reject_vendor_business", {
    p_admin_phone: "admin",
    p_vendor_category_id: sixthVcId,
    p_reason: reason,
  });
  expect(rejected.error, rejected.error?.message).toBeNull();

  const { data: after } = await supabaseAdmin
    .from("vendor_categories")
    .select("status, review_reason")
    .eq("vendor_id", vendorId)
    .eq("category_id", cats[5].id)
    .single();
  expect(after?.status).toBe("rejected");
  expect(after?.review_reason).toBe(reason);

  const sixthMode = String(cats[5].service_mode ?? "help").toLowerCase();
  const { data: radarHidden } = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: sixthMode,
    p_category_ids: [cats[5].id],
  });
  expect(
    ((radarHidden ?? []) as { vendor_id: string; category_id: string }[]).some(
      (r) => r.vendor_id === vendorId && r.category_id === cats[5].id,
    ),
  ).toBe(false);
});
