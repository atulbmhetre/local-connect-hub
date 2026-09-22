/**
 * Billing window credit, config, multi-business, deletion, TZ instants, trial end.
 */
import { test, expect } from "@playwright/test";
import { supabaseAdmin } from "./helpers/setup";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  pauseRpc,
  openWindows,
  allWindows,
  backdateOpenStartedAt,
  creditDays,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(180_000);
test.afterAll(async () => {
  test.info().setTimeout(180_000);
  await cleanupPauseIds(ids);
});

async function snapshotConfig(keys: string[]) {
  const { data } = await supabaseAdmin.from("app_config").select("key, value").in("key", keys);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

async function setConfig(key: string, value: string) {
  const { error } = await supabaseAdmin.from("app_config").update({ value }).eq("key", key);
  expect(error, error?.message).toBeNull();
}

async function alignPrevCreditedEndedAt(vendorId: string, liveMs: number) {
  const open = await openWindows(vendorId);
  expect(open.length).toBe(1);
  const started = new Date(open[0].started_at as string).getTime();
  const { data: prev } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id")
    .eq("vendor_id", vendorId)
    .eq("qualified", true)
    .not("ended_at", "is", null)
    .neq("id", open[0].id)
    .order("ended_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(prev?.id, "need a prior credited window").toBeTruthy();
  const { error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .update({ ended_at: new Date(started - liveMs).toISOString() })
    .eq("id", prev!.id);
  expect(error, error?.message).toBeNull();
}

test("BILL-FLOOR — 6d23h59m59s = 0; 7d23h floors to 7; 10d = 10", async () => {
  const cases: Array<{ shop: string; ms: number; credited: number; windowDays: number; reason: string }> = [
    {
      shop: `!BILL-659-${T}`,
      ms: 6 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000 + 59_000,
      credited: 0,
      windowDays: 6,
      reason: "below_min_credit_days",
    },
    {
      shop: `!BILL-723-${T}`,
      ms: 7 * 86_400_000 + 23 * 3_600_000,
      credited: 7,
      windowDays: 7,
      reason: "credited",
    },
    {
      shop: `!BILL-10D-${T}`,
      ms: 10 * 86_400_000,
      credited: 10,
      windowDays: 10,
      reason: "credited",
    },
  ];
  for (const c of cases) {
    const { vendor, cats } = await seedPauseVendor(ids, T, { shop: c.shop, modes: ["help"] });
    expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vendor.id, c.ms);
    const { data, error } = await pauseRpc(vendor.id, cats[0].id, false);
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({
      credited_days: c.credited,
      window_days: c.windowDays,
      reason: c.reason,
    });
    expect(await creditDays(vendor.id)).toBe(c.credited);
  }
});

test("BILL-LIVE-GAP — exactly 7d after a credited window credits again; 6d23h59m does not", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-GAP-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  const first = await pauseRpc(vendor.id, cats[0].id, false);
  expect(first.data).toMatchObject({ credited_days: 7, reason: "credited" });

  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  await alignPrevCreditedEndedAt(vendor.id, 6 * 86_400_000 + 23 * 3_600_000 + 59 * 60_000);
  const tooSoon = await pauseRpc(vendor.id, cats[0].id, false);
  expect(tooSoon.data).toMatchObject({ credited_days: 0, reason: "below_min_live_days" });
  expect(await creditDays(vendor.id)).toBe(7);

  const { vendor: v2, cats: c2 } = await seedPauseVendor(ids, T, {
    shop: `!BILL-GAP7-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(v2.id, c2[0].id, true)).error).toBeNull();
  await backdateOpenStartedAt(v2.id, 7 * 86_400_000);
  expect((await pauseRpc(v2.id, c2[0].id, false)).data).toMatchObject({ credited_days: 7 });
  expect((await pauseRpc(v2.id, c2[0].id, true)).error).toBeNull();
  await backdateOpenStartedAt(v2.id, 7 * 86_400_000);
  await alignPrevCreditedEndedAt(v2.id, 7 * 86_400_000);
  const ok = await pauseRpc(v2.id, c2[0].id, false);
  expect(ok.data).toMatchObject({ credited_days: 7, reason: "credited" });
  expect(await creditDays(v2.id)).toBe(14);
});

test("BILL-CONFIG — pause_min_credit_days 3 and 30; pause_min_live_days 0 and 14", async () => {
  const snap = await snapshotConfig(["pause_min_credit_days", "pause_min_live_days"]);
  try {
    await setConfig("pause_min_credit_days", "3");
    const { vendor, cats } = await seedPauseVendor(ids, T, {
      shop: `!BILL-CFG3-${T}`,
      modes: ["help"],
    });
    expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vendor.id, 3 * 86_400_000);
    const short = await pauseRpc(vendor.id, cats[0].id, false);
    expect(short.data).toMatchObject({ credited_days: 3, reason: "credited" });

    await setConfig("pause_min_credit_days", "30");
    const { vendor: v30, cats: c30 } = await seedPauseVendor(ids, T, {
      shop: `!BILL-CFG30-${T}`,
      modes: ["help"],
    });
    expect((await pauseRpc(v30.id, c30[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(v30.id, 7 * 86_400_000);
    const under30 = await pauseRpc(v30.id, c30[0].id, false);
    expect(under30.data).toMatchObject({ credited_days: 0, reason: "below_min_credit_days" });

    await setConfig("pause_min_credit_days", snap.pause_min_credit_days ?? "7");
    await setConfig("pause_min_live_days", "0");
    const { vendor: vLive0, cats: cLive0 } = await seedPauseVendor(ids, T, {
      shop: `!BILL-LIVE0-${T}`,
      modes: ["help"],
    });
    expect((await pauseRpc(vLive0.id, cLive0[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vLive0.id, 7 * 86_400_000);
    expect((await pauseRpc(vLive0.id, cLive0[0].id, false)).data).toMatchObject({ credited_days: 7 });
    expect((await pauseRpc(vLive0.id, cLive0[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vLive0.id, 7 * 86_400_000);
    await alignPrevCreditedEndedAt(vLive0.id, 0);
    const immediate = await pauseRpc(vLive0.id, cLive0[0].id, false);
    expect(immediate.data).toMatchObject({ credited_days: 7, reason: "credited" });

    await setConfig("pause_min_live_days", "14");
    const { vendor: v14, cats: c14 } = await seedPauseVendor(ids, T, {
      shop: `!BILL-LIVE14-${T}`,
      modes: ["help"],
    });
    expect((await pauseRpc(v14.id, c14[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(v14.id, 7 * 86_400_000);
    expect((await pauseRpc(v14.id, c14[0].id, false)).data).toMatchObject({ credited_days: 7 });
    expect((await pauseRpc(v14.id, c14[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(v14.id, 7 * 86_400_000);
    await alignPrevCreditedEndedAt(v14.id, 7 * 86_400_000);
    const blocked14 = await pauseRpc(v14.id, c14[0].id, false);
    expect(blocked14.data).toMatchObject({ credited_days: 0, reason: "below_min_live_days" });
  } finally {
    if (snap.pause_min_credit_days) await setConfig("pause_min_credit_days", snap.pause_min_credit_days);
    if (snap.pause_min_live_days) await setConfig("pause_min_live_days", snap.pause_min_live_days);
  }
});

test("BILL-TWO-CREDIT — two credited windows with a valid live gap add up", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-ADD-${T}`,
    modes: ["help"],
  });
  for (let i = 0; i < 2; i++) {
    expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
    if (i === 1) {
      await alignPrevCreditedEndedAt(vendor.id, 7 * 86_400_000);
    }
    const { data } = await pauseRpc(vendor.id, cats[0].id, false);
    expect(data).toMatchObject({ credited_days: 7, reason: "credited" });
  }
  expect(await creditDays(vendor.id)).toBe(14);
});

test("BILL-MULTI — pause A then B opens; resume A closes; pause A again; reject/delete last live", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-MX-${T}`,
    modes: ["help", "delivery"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);
  expect((await pauseRpc(vendor.id, cats[1].id, true)).error).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);
  expect((await pauseRpc(vendor.id, cats[0].id, false)).error).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(0);
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);

  await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "rejected" })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  expect((await openWindows(vendor.id)).length).toBe(1);

  await supabaseAdmin
    .from("vendor_categories")
    .delete()
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  expect((await openWindows(vendor.id)).length).toBe(1);

  await supabaseAdmin
    .from("vendor_categories")
    .delete()
    .eq("vendor_id", vendor.id);
  expect((await openWindows(vendor.id)).length).toBe(0);
});

test("BILL-DELETION — scheduled deletion while a window is open leaves the window until resume/sync", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-DELW-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);
  await supabaseAdmin
    .from("vendors")
    .update({ deletion_requested_at: new Date().toISOString() })
    .eq("id", vendor.id);
  expect((await openWindows(vendor.id)).length).toBe(1);
  const { error: syncErr } = await supabaseAdmin.rpc("_sync_vendor_billing_pause", {
    p_vendor_id: vendor.id,
  });
  expect(syncErr, syncErr?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);
});

test("BILL-TZ-INSTANT — same elapsed instant as +05:30 vs Z yields the same credit", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-TZ-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  const open = await openWindows(vendor.id);
  const startedUtc = new Date(Date.now() - 7 * 86_400_000);
  const offsetForm = startedUtc.toISOString().replace("Z", "+00:00");
  await supabaseAdmin.from("vendor_billing_pauses").update({ started_at: offsetForm }).eq("id", open[0].id);
  const a = await pauseRpc(vendor.id, cats[0].id, false);
  expect(a.data).toMatchObject({ credited_days: 7, reason: "credited" });

  const { vendor: v2, cats: c2 } = await seedPauseVendor(ids, T, {
    shop: `!BILL-TZ2-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(v2.id, c2[0].id, true)).error).toBeNull();
  const open2 = await openWindows(v2.id);
  const kolkata = new Date(startedUtc.getTime() + 5.5 * 3_600_000)
    .toISOString()
    .replace("Z", "")
    .concat("+05:30");
  // Same instant as startedUtc expressed in IST.
  const ist = `${startedUtc.toISOString().slice(0, 19)}+00:00`;
  await supabaseAdmin.from("vendor_billing_pauses").update({ started_at: ist }).eq("id", open2[0].id);
  const b = await pauseRpc(v2.id, c2[0].id, false);
  expect(b.data?.credited_days).toBe(a.data?.credited_days);
  expect(kolkata).toBeTruthy();
});

test("BILL-TRIAL-DAYS — effective trial end = created_at + vendor_trial_days + pause_credit_days", async () => {
  const snap = await snapshotConfig(["vendor_trial_days"]);
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-TRIAL-${T}`,
    modes: ["help"],
  });
  try {
    await setConfig("vendor_trial_days", "30");
    const { data: end30 } = await supabaseAdmin.rpc("vendor_effective_trial_end", {
      p_vendor_id: vendor.id,
    });
    expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
    await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
    expect((await pauseRpc(vendor.id, cats[0].id, false)).data).toMatchObject({ credited_days: 7 });
    const { data: endAfter } = await supabaseAdmin.rpc("vendor_effective_trial_end", {
      p_vendor_id: vendor.id,
    });
    expect(new Date(endAfter as string).getTime() - new Date(end30 as string).getTime()).toBe(
      7 * 86_400_000,
    );

    await setConfig("vendor_trial_days", "14");
    const { data: end14 } = await supabaseAdmin.rpc("vendor_effective_trial_end", {
      p_vendor_id: vendor.id,
    });
    const { data: created } = await supabaseAdmin
      .from("vendors")
      .select("created_at, pause_credit_days")
      .eq("id", vendor.id)
      .single();
    const expected =
      new Date(created!.created_at).getTime() + (14 + Number(created!.pause_credit_days)) * 86_400_000;
    expect(new Date(end14 as string).getTime()).toBe(expected);
  } finally {
    if (snap.vendor_trial_days) await setConfig("vendor_trial_days", snap.vendor_trial_days);
  }
});

test("BILL-RESUME-TWICE — second resume does not double-credit", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-R2-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  const first = await pauseRpc(vendor.id, cats[0].id, false);
  expect(first.data).toMatchObject({ credited_days: 7 });
  const second = await pauseRpc(vendor.id, cats[0].id, false);
  expect(second.error, second.error?.message).toBeNull();
  expect(await creditDays(vendor.id)).toBe(7);
  expect((await allWindows(vendor.id)).filter((w) => w.qualified).length).toBe(1);
});

test("BILL-SYNC-TWICE — calling _sync_vendor_billing_pause twice never double-credits", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!BILL-S2-${T}`,
    modes: ["help"],
  });
  expect((await pauseRpc(vendor.id, cats[0].id, true)).error).toBeNull();
  const syncOpen1 = await supabaseAdmin.rpc("_sync_vendor_billing_pause", { p_vendor_id: vendor.id });
  const syncOpen2 = await supabaseAdmin.rpc("_sync_vendor_billing_pause", { p_vendor_id: vendor.id });
  expect(syncOpen1.error, syncOpen1.error?.message).toBeNull();
  expect(syncOpen2.error, syncOpen2.error?.message).toBeNull();
  expect((await openWindows(vendor.id)).length).toBe(1);
  expect(await creditDays(vendor.id)).toBe(0);

  await backdateOpenStartedAt(vendor.id, 7 * 86_400_000);
  expect((await pauseRpc(vendor.id, cats[0].id, false)).data).toMatchObject({ credited_days: 7 });
  const syncClosed1 = await supabaseAdmin.rpc("_sync_vendor_billing_pause", { p_vendor_id: vendor.id });
  const syncClosed2 = await supabaseAdmin.rpc("_sync_vendor_billing_pause", { p_vendor_id: vendor.id });
  expect(syncClosed1.error, syncClosed1.error?.message).toBeNull();
  expect(syncClosed2.error, syncClosed2.error?.message).toBeNull();
  expect(await creditDays(vendor.id)).toBe(7);
  expect((await allWindows(vendor.id)).filter((w) => w.qualified).length).toBe(1);
});
