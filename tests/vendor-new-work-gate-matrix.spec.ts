/**
 * Shared new-work gate matrix: state combinations, saved/reorder, history,
 * category-omitted routing, and pin that location review uses
 * category_location_review_pending (that code existed before this release).
 */
import { test, expect } from "@playwright/test";
import { supabase, supabaseAdmin } from "./helpers/setup";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  nextPhone,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(120_000);
test.afterAll(async () => {
  await cleanupPauseIds(ids);
});

async function book(vendorId: string, categoryId: string | null, mode: string) {
  const customerPhone = nextPhone(ids, "88084", T);
  const device = `gatex-${T}-${ids.phones.length}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const res = await supabaseAdmin.rpc("create_customer_request", {
    p_device_id: device,
    p_vendor_id: vendorId,
    p_message: "gate-matrix",
    p_user_phone: customerPhone,
    p_device_id_log: device,
    p_category_id: categoryId,
    p_service_mode: mode,
  });
  if (res.data) ids.requestIds.push(res.data as string);
  return { ...res, customerPhone, device };
}

test("GATE-PIN-LOC — pending location review raises category_location_review_pending (pre-release code, still current)", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-PIN-${T}`,
    modes: ["help"],
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ verification_status: "pending_location_review" })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  const { data: code } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(code).toBe("category_location_review_pending");
  const placed = await book(vendor.id, cats[0].id, "help");
  expect(placed.error?.message ?? "").toMatch(/category_location_review_pending/);
  expect(placed.error?.message ?? "").not.toMatch(/vendor_not_discoverable/);
});

test("GATE-PRECEDENCE — deletion beats pause and location review", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-PREC-${T}`,
    modes: ["help"],
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true, verification_status: "pending_location_review" })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", vendor.id);
  const { data } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(data).toBe("vendor_deletion_scheduled");
  const placed = await book(vendor.id, cats[0].id, "help");
  expect(placed.error?.message ?? "").toMatch(/vendor_deletion_scheduled/);
  expect(placed.error?.message ?? "").not.toMatch(/vendor_not_discoverable|category_location_review_pending/);
});

test("GATE-PAUSE-PLUS-LOC — without deletion, location review beats pause", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-PL-${T}`,
    modes: ["help"],
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true, verification_status: "pending_location_review" })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  const { data } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(data).toBe("category_location_review_pending");
});

test("GATE-OMIT-CATEGORY — omitted category routes to another unpaused business on the same account", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-OMIT-${T}`,
    modes: ["help", "delivery"],
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  const resolved = await supabaseAdmin.rpc("_resolve_booking_category", {
    p_vendor_id: vendor.id,
    p_hint_category_id: null,
    p_hint_service_mode: "delivery",
  });
  expect(resolved.error, resolved.error?.message).toBeNull();
  expect(resolved.data).toBeTruthy();
  const placed = await book(vendor.id, null, "delivery");
  expect(placed.error, placed.error?.message).toBeNull();
});

test("GATE-NONE — with none of pause / location review / deletion, new work is allowed", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-NONE-${T}`,
    modes: ["help"],
  });
  const { data: code } = await supabaseAdmin.rpc("vendor_business_new_work_block", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(code).toBeNull();
  const placed = await book(vendor.id, cats[0].id, "help");
  expect(placed.error, placed.error?.message).toBeNull();
  expect(placed.data).toBeTruthy();
});

test("GATE-SAVED-HISTORY — paused vendor stays on saved/history; new work is blocked", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!GATE-SAVE-${T}`,
    modes: ["help"],
  });
  const customerPhone = nextPhone(ids, "88085", T);
  const device = `gate-save-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data: prior } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: device,
      vendor_id: vendor.id,
      message: "history",
      user_phone: customerPhone,
      status: "done",
      category_id: cats[0].id,
      service_mode: "help",
    })
    .select("id")
    .single();
  ids.requestIds.push(prior!.id);
  const saved = await supabase.rpc("save_saved_vendor", {
    p_vendor_id: vendor.id,
    p_category: cats[0].label,
    p_nickname: "",
    p_device_id: device,
    p_user_phone: customerPhone,
  });
  expect(saved.error, saved.error?.message).toBeNull();
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);

  const hist = await supabase.rpc("get_vendors_visible_to_customer", {
    p_vendor_ids: [vendor.id],
    p_user_phone: customerPhone,
    p_device_id: device,
  });
  expect(hist.error, hist.error?.message).toBeNull();
  expect(((hist.data ?? []) as { id: string }[]).some((r) => r.id === vendor.id)).toBe(true);

  const placed = await book(vendor.id, cats[0].id, "help");
  expect(placed.error?.message ?? "").toMatch(/vendor_not_discoverable/);

  const radar = await supabase.rpc("get_radar_category_mode_matches", {
    p_mode: "help",
    p_category_ids: [cats[0].id],
  });
  expect(((radar.data ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendor.id)).toBe(
    false,
  );
});
