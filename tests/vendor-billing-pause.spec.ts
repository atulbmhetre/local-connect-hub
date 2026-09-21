/**
 * Phase 2: account billing-freeze windows and trial pause credit.
 * Uses timestamptz elapsed (86400s days), not calendar dates.
 */
import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
  vendorPhoneById,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

test.setTimeout(120_000);

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_billing_pauses").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_pause_events").delete().eq("vendor_id", id);
    await deleteVendorRegistrationArtifacts(id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
});

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedAccount(opts: {
  shop: string;
  modes: Array<"help" | "delivery" | "appointment">;
}) {
  const cats = [];
  for (const mode of opts.modes) {
    cats.push(await getActiveCategoryByServiceMode(mode));
  }
  const vendorPhone = nextPhone("99072");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Billing Pause Vendor",
      shop_name: opts.shop,
      category: cats[0].label,
      service_mode: opts.modes[0],
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
      trial_ends_at: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id, phone, shop_name, created_at, pause_credit_days")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  for (let i = 0; i < cats.length; i++) {
    await seedVendorCategory(vendor!.id, cats[i], {
      is_primary: i === 0,
      modes: [opts.modes[i]],
    });
  }
  return { vendor: vendor!, cats };
}

async function pauseRpc(vendorId: string, categoryId: string, paused: boolean) {
  const phone = await vendorPhoneById(vendorId);
  return supabase.rpc("vendor_update_category_profile", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_category_id: categoryId,
    p_patch: { is_paused: paused },
  });
}

async function openWindows(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id, started_at, ended_at, days, credited_days, qualified")
    .eq("vendor_id", vendorId)
    .is("ended_at", null);
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

async function allWindows(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id, started_at, ended_at, days, credited_days, qualified")
    .eq("vendor_id", vendorId)
    .order("started_at", { ascending: true });
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

async function creditDays(vendorId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("vendors")
    .select("pause_credit_days")
    .eq("id", vendorId)
    .single();
  expect(error, error?.message).toBeNull();
  return Number(data?.pause_credit_days ?? 0);
}

async function backdateOpenStartedAt(vendorId: string, msAgo: number) {
  const open = await openWindows(vendorId);
  expect(open.length, "expected an open billing window to backdate").toBe(1);
  const startedAt = new Date(Date.now() - msAgo).toISOString();
  const { error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .update({ started_at: startedAt })
    .eq("id", open[0].id);
  expect(error, error?.message).toBeNull();
}

test("BILL-01 — 6d 23h 59m window = no credit; resume payload", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-6D-${T}`, modes: ["help"] });
  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);

  await backdateOpenStartedAt(
    vendor.id,
    6 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000,
  );

  const { data, error } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(error, error?.message).toBeNull();
  expect(data).toMatchObject({
    credited_days: 0,
    window_days: 6,
    qualified: false,
    reason: "below_min_credit_days",
  });
  expect(await creditDays(vendor.id)).toBe(0);
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-02 — 7d 0h = 7 credited; SQL trial end moves by 7 days", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-7D-${T}`, modes: ["help"] });
  const { data: beforeEnd, error: beforeErr } = await supabaseAdmin.rpc(
    "vendor_effective_trial_end",
    { p_vendor_id: vendor.id },
  );
  expect(beforeErr, beforeErr?.message).toBeNull();

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);

  const { data, error } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(error, error?.message).toBeNull();
  expect(data).toMatchObject({
    credited_days: 7,
    window_days: 7,
    qualified: true,
    reason: "credited",
  });
  expect(await creditDays(vendor.id)).toBe(7);

  const { data: afterEnd, error: afterErr } = await supabaseAdmin.rpc(
    "vendor_effective_trial_end",
    { p_vendor_id: vendor.id },
  );
  expect(afterErr, afterErr?.message).toBeNull();
  const deltaMs = new Date(afterEnd as string).getTime() - new Date(beforeEnd as string).getTime();
  expect(deltaMs).toBe(7 * 86_400_000);

  const { error: syncAgain } = await supabaseAdmin.rpc("_sync_vendor_billing_pause", {
    p_vendor_id: vendor.id,
  });
  expect(syncAgain, syncAgain?.message).toBeNull();
  expect(await creditDays(vendor.id)).toBe(7);
});

test("BILL-03 — 30 nightly pause/resume on a single-business account = 0 credit", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-NIGHT-${T}`, modes: ["help"] });
  for (let i = 0; i < 30; i++) {
    const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
    expect(pauseErr, pauseErr?.message).toBeNull();
    await backdateOpenStartedAt(vendor.id, 60 * 60 * 1000);
    const { data, error } = await pauseRpc(vendor.id, cats[0].id, false);
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({
      credited_days: 0,
      qualified: false,
      reason: "below_min_credit_days",
    });
  }
  expect(await creditDays(vendor.id)).toBe(0);
  const windows = await allWindows(vendor.id);
  expect(windows.length).toBe(30);
  expect(windows.every((w) => w.qualified === false && w.credited_days === 0)).toBe(true);
});

test("BILL-04 — pause one of two businesses opens no window; last pause opens; any resume closes", async () => {
  const { vendor, cats } = await seedAccount({
    shop: `!BILL-TWO-${T}`,
    modes: ["help", "delivery"],
  });
  expect(cats[0].id).not.toBe(cats[1].id);

  const { error: p1 } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(p1, p1?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);

  const { error: p2 } = await pauseRpc(vendor.id, cats[1].id, true);
  expect(p2, p2?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);

  const { data: resume, error: r1 } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(r1, r1?.message).toBeNull();
  expect(resume).toMatchObject({
    credited_days: 0,
    qualified: false,
    reason: "below_min_credit_days",
  });
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-05 — approving a new business closes an open window", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-APPR-${T}`, modes: ["help"] });
  const extra = await getActiveCategoryByServiceMode("delivery");

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);

  await seedVendorCategory(vendor.id, extra, {
    is_primary: false,
    modes: ["delivery"],
  });
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-06 — second qualifying pause too soon after the first = no credit", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-LIVE-${T}`, modes: ["help"] });

  const { error: p1 } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(p1, p1?.message).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  const { data: first, error: r1 } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(r1, r1?.message).toBeNull();
  expect(first).toMatchObject({ credited_days: 7, qualified: true, reason: "credited" });
  expect(await creditDays(vendor.id)).toBe(7);

  const { error: p2 } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(p2, p2?.message).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  const { data: second, error: r2 } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(r2, r2?.message).toBeNull();
  expect(second).toMatchObject({
    credited_days: 0,
    window_days: 7,
    qualified: false,
    reason: "below_min_live_days",
  });
  expect(await creditDays(vendor.id)).toBe(7);
});

test("BILL-07 — vendor cannot write pause_credit_days; pauses table is not directly writable", async () => {
  const { vendor } = await seedAccount({ shop: `!BILL-GUARD-${T}`, modes: ["help"] });
  const phone = await vendorPhoneById(vendor.id);

  const { error } = await supabase.rpc("vendor_update_own", {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_patch: { pause_credit_days: 99 },
  });
  expect(error?.message ?? "").toContain("field_not_allowed");
  expect(await creditDays(vendor.id)).toBe(0);

  const { error: insErr } = await supabase.from("vendor_billing_pauses").insert({
    vendor_id: vendor.id,
    started_at: new Date().toISOString(),
  });
  expect(insErr, "anon must not insert billing pauses").toBeTruthy();
});

test("BILL-EVIDENCE — real TEST vendor pause then resume (before/after)", async () => {
  const { vendor, cats } = await seedAccount({
    shop: `!BILL-EVIDENCE-${T}`,
    modes: ["help"],
  });
  const beforeCredit = await creditDays(vendor.id);
  const beforeWindows = await allWindows(vendor.id);
  const { data: beforeTrial } = await supabaseAdmin.rpc("vendor_effective_trial_end", {
    p_vendor_id: vendor.id,
  });

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  const midOpen = await openWindows(vendor.id);
  expect(midOpen.length).toBe(1);

  const { data: resume, error: resumeErr } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(resumeErr, resumeErr?.message).toBeNull();
  const afterCredit = await creditDays(vendor.id);
  const afterWindows = await allWindows(vendor.id);
  const { data: afterTrial } = await supabaseAdmin.rpc("vendor_effective_trial_end", {
    p_vendor_id: vendor.id,
  });

  expect(beforeCredit).toBe(0);
  expect(beforeWindows.length).toBe(0);
  expect(resume).toMatchObject({
    credited_days: 0,
    qualified: false,
    reason: "below_min_credit_days",
  });
  expect(afterCredit).toBe(0);
  expect(afterWindows.length).toBe(1);
  expect(afterWindows[0].ended_at).toBeTruthy();
  expect(afterWindows[0].qualified).toBe(false);
  expect(String(beforeTrial)).toBe(String(afterTrial));

  console.log(
    JSON.stringify({
      evidence: "BILL-EVIDENCE",
      vendor_id: vendor.id,
      shop_name: vendor.shop_name,
      before: { pause_credit_days: beforeCredit, windows: beforeWindows.length, trial_end: beforeTrial },
      paused_open_window_id: midOpen[0].id,
      after: {
        pause_credit_days: afterCredit,
        windows: afterWindows,
        trial_end: afterTrial,
        resume,
      },
    }),
  );
});

async function insertBusiness(
  vendorId: string,
  category: { id: string; service_mode: string },
  opts: { status: "approved" | "pending" | "pending_review" | "rejected"; is_paused?: boolean; is_primary?: boolean },
) {
  await seedVendorCategory(vendorId, category, {
    is_primary: opts.is_primary ?? false,
    modes: [category.service_mode],
    status: opts.status,
  });
  if (opts.is_paused) {
    const { error } = await supabaseAdmin
      .from("vendor_categories")
      .update({ is_paused: true })
      .eq("vendor_id", vendorId)
      .eq("category_id", category.id);
    expect(error, error?.message).toBeNull();
  }
}

test("BILL-PEND-01 — pending-only vendor opens no window; approving it still opens none", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-PEND-${T}`, modes: ["help"] });
  const { error: delErr } = await supabaseAdmin
    .from("vendor_categories")
    .delete()
    .eq("vendor_id", vendor.id);
  expect(delErr, delErr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);

  await insertBusiness(vendor.id, cats[0], { status: "pending", is_primary: true });
  expect((await openWindows(vendor.id)).length).toBe(0);

  const { error: appr } = await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "approved", is_paused: false })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  expect(appr, appr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-PEND-02 — only rejected business opens no window", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!BILL-REJ-${T}`, modes: ["help"] });
  const { error: delErr } = await supabaseAdmin
    .from("vendor_categories")
    .delete()
    .eq("vendor_id", vendor.id);
  expect(delErr, delErr?.message).toBeNull();

  await insertBusiness(vendor.id, cats[0], { status: "rejected", is_primary: true });
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-PEND-03 — approved paused + pending opens a window; approving the pending one closes it", async () => {
  const { vendor, cats } = await seedAccount({
    shop: `!BILL-MIX-${T}`,
    modes: ["help", "delivery"],
  });
  const { error: delPendingSlot } = await supabaseAdmin
    .from("vendor_categories")
    .delete()
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[1].id);
  expect(delPendingSlot, delPendingSlot?.message).toBeNull();

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);

  await insertBusiness(vendor.id, cats[1], { status: "pending", is_primary: false });
  expect((await openWindows(vendor.id)).length).toBe(1);

  const { error: appr } = await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "approved", is_paused: false })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[1].id);
  expect(appr, appr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);
});
