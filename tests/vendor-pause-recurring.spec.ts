/**
 * Recurring skip notices: two parents, other vendors, customer language.
 */
import { test, expect } from "@playwright/test";
import { supabase, supabaseAdmin } from "./helpers/setup";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  pauseRpc,
  nextPhone,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(120_000);
test.afterAll(async () => {
  await cleanupPauseIds(ids);
});

async function makeParent(vendorId: string, categoryId: string, phone: string, device: string, message: string) {
  const { data: firstId, error } = await supabase.rpc("create_recurring_order", {
    p_device_id: device,
    p_vendor_id: vendorId,
    p_message: message,
    p_interval_kind: "daily",
    p_user_phone: phone,
    p_device_id_log: device,
    p_delivery_address: "Pune test",
    p_delivery_slot: "evening",
    p_delivery_slot_deadline: new Date(Date.now() + 6 * 3600_000).toISOString(),
    p_category_id: categoryId,
    p_service_mode: "delivery",
  });
  expect(error, error?.message).toBeNull();
  ids.requestIds.push(firstId as string);
  await supabaseAdmin.from("requests").update({ status: "done" }).eq("id", firstId as string);
  const { data: firstReq } = await supabaseAdmin
    .from("requests")
    .select("recurring_order_id")
    .eq("id", firstId as string)
    .single();
  return firstReq!.recurring_order_id as string;
}

test("REC-TWO-PARENTS — two parents for the same paused vendor each get one skip notice", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!REC-2P-${T}`,
    modes: ["delivery"],
  });
  const p1 = nextPhone(ids, "88086", T);
  const p2 = nextPhone(ids, "88086", T);
  await supabaseAdmin.from("users").upsert({ phone: p1, trust_score: 75 }, { onConflict: "phone" });
  await supabaseAdmin.from("users").upsert({ phone: p2, trust_score: 75 }, { onConflict: "phone" });
  const parentA = await makeParent(vendor.id, cats[0].id, p1, `rec-a-${T}`, "parent A");
  const parentB = await makeParent(vendor.id, cats[0].id, p2, `rec-b-${T}`, "parent B");
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  await supabaseAdmin.from("recurring_orders").update({ next_run_at: new Date(Date.now() - 60_000).toISOString() }).in("id", [parentA, parentB]);
  await supabaseAdmin.rpc("spawn_due_recurring_orders");
  const { data: n1 } = await supabaseAdmin.from("user_notifications").select("id").eq("user_phone", p1).eq("type", "recurring_skipped_paused");
  const { data: n2 } = await supabaseAdmin.from("user_notifications").select("id").eq("user_phone", p2).eq("type", "recurring_skipped_paused");
  expect(n1).toHaveLength(1);
  expect(n2).toHaveLength(1);
});

test("REC-OTHER-VENDOR — paused vendor's skip does not touch another vendor's parent", async () => {
  const a = await seedPauseVendor(ids, T, { shop: `!REC-OA-${T}`, modes: ["delivery"] });
  const b = await seedPauseVendor(ids, T, { shop: `!REC-OB-${T}`, modes: ["delivery"] });
  const phone = nextPhone(ids, "88087", T);
  await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  const parentB = await makeParent(b.vendor.id, b.cats[0].id, phone, `rec-ob-${T}`, "other parent");
  expect((await pauseRpc(a.vendor.id, a.cats[0].id, true)).error).toBeNull();
  await supabaseAdmin.from("recurring_orders").update({ next_run_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", parentB);
  await supabaseAdmin.rpc("spawn_due_recurring_orders");
  const { data: notes } = await supabaseAdmin.from("user_notifications").select("id").eq("user_phone", phone).eq("type", "recurring_skipped_paused");
  expect(notes ?? []).toHaveLength(0);
  const { data: parent } = await supabaseAdmin.from("recurring_orders").select("skip_notified_at").eq("id", parentB).single();
  expect(parent?.skip_notified_at).toBeNull();
});

test("REC-LANG — skip notice uses the customer's language", async () => {
  for (const lang of ["en", "hi", "mr"] as const) {
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!REC-L-${lang}-${T}`,
      modes: ["delivery"],
    });
    const phone = nextPhone(ids, "88088", T);
    await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
    await supabaseAdmin.from("app_users").upsert({ phone, lang }, { onConflict: "phone" });
    const parent = await makeParent(vendor.id, cats[0].id, phone, `rec-l-${lang}-${T}`, "lang parent");
    expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
    await supabaseAdmin.from("recurring_orders").update({ next_run_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", parent);
    await supabaseAdmin.rpc("spawn_due_recurring_orders");
    const { data: notes } = await supabaseAdmin
      .from("user_notifications")
      .select("body")
      .eq("user_phone", phone)
      .eq("type", "recurring_skipped_paused");
    expect(notes).toHaveLength(1);
    const body = String(notes![0].body);
    expect(body).toBeTruthy();
    if (lang === "en") {
      expect(body).toMatch(/on a break|skipped/i);
    } else {
      expect(body).not.toMatch(/on a break/);
      expect(body).not.toMatch(/\{shop_name\}/);
    }
    if (lang === "hi") expect(body).toMatch(/आवर्ती|ऑर्डर/);
    if (lang === "mr") expect(body).toMatch(/आवर्ती|ऑर्डर/);
  }
});

test("REC-RESUME-SPAWN — resume then spawn succeeds and clears the skip flag", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!REC-RS-${T}`,
    modes: ["delivery"],
  });
  const phone = nextPhone(ids, "88089", T);
  await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  const parent = await makeParent(vendor.id, cats[0].id, phone, `rec-rs-${T}`, "resume spawn");
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parent);
  await supabaseAdmin.rpc("spawn_due_recurring_orders");
  const { data: skipped } = await supabaseAdmin
    .from("recurring_orders")
    .select("skip_notified_at")
    .eq("id", parent)
    .single();
  expect(skipped?.skip_notified_at).toBeTruthy();

  expect((await pauseRpc(vendor.id, cats[0].id, false)).error).toBeNull();
  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parent);
  const spawn = await supabaseAdmin.rpc("spawn_due_recurring_orders");
  expect(spawn.error, spawn.error?.message).toBeNull();
  expect(Number(spawn.data)).toBeGreaterThanOrEqual(1);
  const { data: after } = await supabaseAdmin
    .from("recurring_orders")
    .select("skip_notified_at")
    .eq("id", parent)
    .single();
  expect(after?.skip_notified_at).toBeNull();
});
