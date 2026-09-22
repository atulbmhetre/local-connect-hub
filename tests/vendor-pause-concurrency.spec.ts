/**
 * Two real connections: pause vs placement, pause after order, double-tap.
 */
import { test, expect } from "@playwright/test";
import { supabaseAdmin } from "./helpers/setup";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  insertRequest,
  pauseRpc,
  nextPhone,
  openWindows,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(90_000);
test.afterAll(async () => {
  await cleanupPauseIds(ids);
});

test("CONC-PAUSE-PLACE — pause and placement in parallel: never both succeed", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!CONC-PP-${T}`,
    modes: ["help"],
  });
  const customerPhone = nextPhone(ids, "88083", T);
  const device = `conc-pp-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });

  const [pauseRes, bookRes] = await Promise.all([
    pauseRpc(vendor.id, cats[0].id, true),
    supabaseAdmin.rpc("create_customer_request", {
      p_device_id: device,
      p_vendor_id: vendor.id,
      p_message: "conc-pause-place",
      p_user_phone: customerPhone,
      p_device_id_log: device,
      p_category_id: cats[0].id,
      p_service_mode: "help",
    }),
  ]);
  const paused = pauseRes.error == null;
  const booked = bookRes.error == null && !!bookRes.data;
  expect(paused && booked, "must not accept an order on a business that also paused").toBe(false);
  if (booked) {
    ids.requestIds.push(bookRes.data as string);
    expect(pauseRes.error?.message ?? "").toMatch(/pause_blocked_open_work/);
  }
  if (paused) {
    expect(bookRes.error?.message ?? "").toMatch(/vendor_not_discoverable/);
    const { data: rows } = await supabaseAdmin
      .from("requests")
      .select("id")
      .eq("vendor_id", vendor.id)
      .eq("status", "sent");
    expect(rows ?? []).toHaveLength(0);
  }
});

test("CONC-ORDER-THEN-PAUSE — committed order refuses pause", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!CONC-OP-${T}`,
    modes: ["help"],
  });
  await insertRequest(ids, T, {
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error?.message ?? "").toMatch(/pause_blocked_open_work/);
});

test("CONC-DOUBLE-TAP — parallel pause once, parallel resume once: one event, one window, one credit", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!CONC-DT-${T}`,
    modes: ["help"],
  });
  const [p1, p2] = await Promise.all([
    pauseRpc(vendor.id, cats[0].id, true),
    pauseRpc(vendor.id, cats[0].id, true),
  ]);
  expect(p1.error == null || p2.error == null).toBe(true);
  const { data: events } = await supabaseAdmin
    .from("vendor_pause_events")
    .select("id")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .is("resumed_at", null);
  expect(events?.length).toBe(1);
  expect((await openWindows(vendor.id)).length).toBe(1);

  const open = await openWindows(vendor.id);
  await supabaseAdmin
    .from("vendor_billing_pauses")
    .update({ started_at: new Date(Date.now() - 7 * 86_400_000).toISOString() })
    .eq("id", open[0].id);

  const [r1, r2] = await Promise.all([
    pauseRpc(vendor.id, cats[0].id, false),
    pauseRpc(vendor.id, cats[0].id, false),
  ]);
  expect(r1.error == null && r2.error == null).toBe(true);
  const { data: vendorRow } = await supabaseAdmin
    .from("vendors")
    .select("pause_credit_days")
    .eq("id", vendor.id)
    .single();
  expect(Number(vendorRow?.pause_credit_days)).toBe(7);
  const { data: credited } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id")
    .eq("vendor_id", vendor.id)
    .eq("qualified", true);
  expect(credited?.length).toBe(1);
});
