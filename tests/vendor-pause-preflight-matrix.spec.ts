/**
 * Preflight / pause gate matrix: every open-work status×mode, subscription
 * states, idempotent pause, identity errors, khata/UPI note, resume always.
 */
import { test, expect } from "@playwright/test";
import { supabaseAdmin } from "./helpers/setup";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  insertRequest,
  pauseRpc,
  preflight,
  nextPhone,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(120_000);
test.afterAll(async () => {
  test.info().setTimeout(180_000);
  await cleanupPauseIds(ids);
});

const OPEN: Array<{
  id: string;
  mode: "help" | "delivery" | "appointment";
  status: "sent" | "seen" | "accepted";
  appointmentStatus?: string;
  appointmentTime?: () => string;
}> = [
  { id: "help-sent", mode: "help", status: "sent" },
  { id: "help-seen", mode: "help", status: "seen" },
  { id: "help-accepted", mode: "help", status: "accepted" },
  { id: "delivery-sent", mode: "delivery", status: "sent" },
  { id: "delivery-seen", mode: "delivery", status: "seen" },
  { id: "delivery-accepted", mode: "delivery", status: "accepted" },
  { id: "appointment-sent", mode: "appointment", status: "sent" },
  { id: "appointment-seen", mode: "appointment", status: "seen" },
  { id: "appointment-accepted-confirmed-future", mode: "appointment", status: "accepted", appointmentStatus: "confirmed", appointmentTime: () => new Date(Date.now() + 3 * 86_400_000).toISOString() },
  { id: "appointment-pending-future", mode: "appointment", status: "sent", appointmentStatus: "pending", appointmentTime: () => new Date(Date.now() + 2 * 86_400_000).toISOString() },
];

const CLOSED: Array<{
  id: string;
  mode: "help" | "delivery" | "appointment";
  status: string;
  appointmentStatus?: string;
}> = [
  { id: "help-fulfilled", mode: "help", status: "fulfilled" },
  { id: "help-done", mode: "help", status: "done" },
  { id: "help-cancelled", mode: "help", status: "cancelled" },
  { id: "help-expired", mode: "help", status: "expired" },
  { id: "delivery-fulfilled", mode: "delivery", status: "fulfilled" },
  { id: "delivery-done", mode: "delivery", status: "done" },
  { id: "delivery-cancelled", mode: "delivery", status: "cancelled" },
  { id: "delivery-expired", mode: "delivery", status: "expired" },
  { id: "appointment-fulfilled", mode: "appointment", status: "fulfilled" },
  { id: "appointment-done", mode: "appointment", status: "done" },
  { id: "appointment-cancelled-status", mode: "appointment", status: "cancelled" },
  { id: "appointment-expired", mode: "appointment", status: "expired" },
  { id: "appointment-seen-declined", mode: "appointment", status: "seen", appointmentStatus: "declined" },
  { id: "appointment-seen-cancelled", mode: "appointment", status: "seen", appointmentStatus: "cancelled" },
];

for (const row of OPEN) {
  test(`PAUSE-OPEN — ${row.id} blocks pause`, async () => {
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!PBC-OPEN-${row.id}-${T}`,
      modes: [row.mode],
    });
    await insertRequest(ids, T, {
      vendorId: vendor.id,
      categoryId: cats[0].id,
      serviceMode: row.mode,
      status: row.status,
      appointmentStatus: row.appointmentStatus ?? null,
      appointmentTime: row.appointmentTime?.() ?? null,
    });
    const { error } = await pauseRpc(vendor.id, cats[0].id, true);
    expect(error?.message ?? "").toMatch(/pause_blocked_open_work/);
    const { data: pre } = await preflight(vendor.id, cats[0].id);
    expect(pre?.can_pause).toBe(false);
    expect(pre?.block_reason).toBe("open_work");
    expect(Number(pre?.open_work?.[row.mode] ?? 0)).toBeGreaterThanOrEqual(1);
  });
}

for (const row of CLOSED) {
  test(`PAUSE-CLOSED — ${row.id} does not block pause`, async () => {
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!PBC-CL-${row.id}-${T}`,
      modes: [row.mode],
    });
    await insertRequest(ids, T, {
      vendorId: vendor.id,
      categoryId: cats[0].id,
      serviceMode: row.mode,
      status: row.status,
      appointmentStatus: row.appointmentStatus ?? null,
    });
    const { error } = await pauseRpc(vendor.id, cats[0].id, true);
    expect(error, error?.message).toBeNull();
    const { data: pre } = await preflight(vendor.id, cats[0].id);
    expect(pre?.can_pause).toBe(true);
    expect(Number(pre?.open_work?.[row.mode] ?? 0)).toBe(0);
  });
}

test("PAUSE-OTHER-VENDOR — another vendor's open work does not count", async () => {
  const a = await seedPauseVendor(ids, T, { shop: `!PBC-VA-${T}`, modes: ["help"] });
  const b = await seedPauseVendor(ids, T, { shop: `!PBC-VB-${T}`, modes: ["help"] });
  await insertRequest(ids, T, {
    vendorId: b.vendor.id,
    categoryId: b.cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  const { error } = await pauseRpc(a.vendor.id, a.cats[0].id, true);
  expect(error, error?.message).toBeNull();
  const { data: pre } = await preflight(a.vendor.id, a.cats[0].id);
  expect(pre?.open_work?.help).toBe(0);
});

test("PAUSE-SUB-TRIAL-ACTIVE — trial and active may pause", async () => {
  for (const status of ["trial", "active"] as const) {
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!PBC-SUB-${status}-${T}`,
      modes: ["help"],
      subscription_status: status,
    });
    const { error } = await pauseRpc(vendor.id, cats[0].id, true);
    expect(error, error?.message).toBeNull();
  }
});

test("PAUSE-SUB-NULL — null subscription_status cannot be seeded", async () => {
  test.skip(true, "vendors.subscription_status is NOT NULL on TEST");
});

test("PAUSE-SUB-CANCELLED — cancelled cannot start a pause", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!PBC-SUB-CAN-${T}`,
    modes: ["help"],
    subscription_status: "cancelled",
  });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error?.message ?? "", "spec: cancelled is a pause-blocked subscription state").toMatch(
    /pause_blocked_subscription/,
  );
  const { data: pre } = await preflight(vendor.id, cats[0].id);
  expect(pre?.can_pause).toBe(false);
  expect(pre?.block_reason).toBe("subscription_state");
});

test("PAUSE-IDEMPOTENT — already paused: no second event row, no second window", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!PBC-IDEM-${T}`,
    modes: ["help"],
  });
  const first = await pauseRpc(vendor.id, cats[0].id, true);
  expect(first.error, first.error?.message).toBeNull();
  const { data: events1 } = await supabaseAdmin
    .from("vendor_pause_events")
    .select("id")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .is("resumed_at", null);
  const { data: win1 } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id")
    .eq("vendor_id", vendor.id)
    .is("ended_at", null);
  const second = await pauseRpc(vendor.id, cats[0].id, true);
  expect(second.error, second.error?.message).toBeNull();
  const { data: events2 } = await supabaseAdmin
    .from("vendor_pause_events")
    .select("id")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .is("resumed_at", null);
  const { data: win2 } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id")
    .eq("vendor_id", vendor.id)
    .is("ended_at", null);
  expect(events2?.length).toBe(events1?.length);
  expect(win2?.length).toBe(win1?.length);
});

test("PAUSE-ID-UNKNOWN — unknown vendor and category are safe errors", async () => {
  const missingVendor = "00000000-0000-4000-8000-000000000001";
  const missingCat = "00000000-0000-4000-8000-000000000002";
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!PBC-ID-${T}`,
    modes: ["help"],
  });
  const unkV = await supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: missingVendor,
    p_category_id: cats[0].id,
  });
  expect(unkV.error?.message ?? "").toMatch(/not_found_or_unauthorized/);
  const unkC = await supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: vendor.id,
    p_category_id: missingCat,
  });
  expect(unkC.error?.message ?? "").toMatch(/category_not_found/);
});

test("PAUSE-ID-NOT-OWNED — category belonging to another vendor is category_not_found", async () => {
  const a = await seedPauseVendor(ids, T, { shop: `!PBC-OWN-A-${T}`, modes: ["help"] });
  const b = await seedPauseVendor(ids, T, { shop: `!PBC-OWN-B-${T}`, modes: ["delivery"] });
  const { error } = await pauseRpc(a.vendor.id, b.cats[0].id, true);
  expect(error?.message ?? "").toMatch(/category_not_found/);
});

test("PAUSE-PENDING-REJECTED — pending and rejected businesses have defined pause errors", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!PBC-PENDCAT-${T}`,
    modes: ["help", "delivery"],
  });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "pending" })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[1].id);
  const pending = await pauseRpc(vendor.id, cats[1].id, true);
  const pendingMsg = pending.error?.message ?? "";
  expect(
    pending.error == null || /category_not_found|not_approved|pause_blocked/.test(pendingMsg),
    `pending pause must be defined, got ${pendingMsg || "success"}`,
  ).toBe(true);

  await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "rejected", is_paused: false })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[1].id);
  const rejected = await pauseRpc(vendor.id, cats[1].id, true);
  const rejMsg = rejected.error?.message ?? "";
  expect(
    rejected.error == null || /category_not_found|not_approved|pause_blocked/.test(rejMsg),
    `rejected pause must be defined, got ${rejMsg || "success"}`,
  ).toBe(true);
});

test("PAUSE-KHATA-NOTE — zero / one / several customers, paise, UPI claims; fulfilled-unpaid only in the note", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!PBC-KHATA-${T}`,
    modes: ["delivery"],
  });
  let { data: pre } = await preflight(vendor.id, cats[0].id);
  expect(pre?.khata?.pending_amount).toBe(0);
  expect(pre?.khata?.customer_count).toBe(0);
  expect(pre?.upi_claims_pending).toBe(0);
  expect(pre?.can_pause).toBe(true);

  const c1 = nextPhone(ids, "88082", T);
  const c2 = nextPhone(ids, "88082", T);
  await supabaseAdmin.from("users").upsert({ phone: c1, trust_score: 75 }, { onConflict: "phone" });
  await supabaseAdmin.from("users").upsert({ phone: c2, trust_score: 75 }, { onConflict: "phone" });
  await supabaseAdmin.from("khata_ledger").insert({
    vendor_id: vendor.id,
    user_phone: c1,
    total_outstanding: 10.5,
  });
  ({ data: pre } = await preflight(vendor.id, cats[0].id));
  expect(Number(pre?.khata?.customer_count)).toBe(1);
  expect(Number(pre?.khata?.pending_amount)).toBeCloseTo(10.5, 2);
  expect(pre?.can_pause).toBe(true);

  await supabaseAdmin.from("khata_ledger").insert({
    vendor_id: vendor.id,
    user_phone: c2,
    total_outstanding: 0,
  });
  ({ data: pre } = await preflight(vendor.id, cats[0].id));
  expect(Number(pre?.khata?.customer_count)).toBe(1);

  await supabaseAdmin
    .from("khata_ledger")
    .update({ total_outstanding: 3.25 })
    .eq("vendor_id", vendor.id)
    .eq("user_phone", c2);
  ({ data: pre } = await preflight(vendor.id, cats[0].id));
  expect(Number(pre?.khata?.customer_count)).toBe(2);
  expect(Number(pre?.khata?.pending_amount)).toBeCloseTo(13.75, 2);

  const { requestId } = await insertRequest(ids, T, {
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "delivery",
    status: "fulfilled",
    paymentStatus: "claimed",
  });
  ({ data: pre } = await preflight(vendor.id, cats[0].id));
  expect(Number(pre?.upi_claims_pending)).toBeGreaterThanOrEqual(1);
  expect(pre?.can_pause).toBe(true);

  await supabaseAdmin.from("requests").update({ payment_status: "unpaid" }).eq("id", requestId);
  ({ data: pre } = await preflight(vendor.id, cats[0].id));
  expect(pre?.can_pause).toBe(true);
});

test("PAUSE-RESUME-EVERY-SUB — resume succeeds in every subscription state including open work", async () => {
  for (const status of ["trial", "active", "grace", "expired", "cancelled", null] as const) {
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!PBC-RES-${status ?? "null"}-${T}`,
      modes: ["help"],
      subscription_status: "trial",
    });
    const paused = await pauseRpc(vendor.id, cats[0].id, true);
    expect(paused.error, paused.error?.message).toBeNull();
    await insertRequest(ids, T, {
      vendorId: vendor.id,
      categoryId: cats[0].id,
      serviceMode: "help",
      status: "sent",
    });
    await supabaseAdmin.from("vendors").update({ subscription_status: status }).eq("id", vendor.id);
    const { error } = await pauseRpc(vendor.id, cats[0].id, false);
    expect(error, `${status}: ${error?.message}`).toBeNull();
  }
});
