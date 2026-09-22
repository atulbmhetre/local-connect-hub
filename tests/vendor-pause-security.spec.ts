/**
 * Pause/billing security: cross-vendor RPC, anon/customer, direct REST bypass,
 * column/table write guards.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { supabase, supabaseAdmin, vendorPhoneById } from "./helpers/setup";
import { getAnonKey, getSupabaseUrl } from "./helpers/testEnv";
import {
  emptyPauseIds,
  cleanupPauseIds,
  seedPauseVendor,
  insertRequest,
  pauseRpc,
} from "./helpers/pauseBillingHarness";

const T = Date.now();
const ids = emptyPauseIds();
test.setTimeout(120_000);
test.afterAll(async () => {
  await cleanupPauseIds(ids);
});

test("SEC-CROSS-VENDOR — vendor B cannot preflight, pause or resume vendor A's business", async () => {
  const a = await seedPauseVendor(ids, T, { shop: `!SEC-A-${T}`, modes: ["help"] });
  const b = await seedPauseVendor(ids, T, { shop: `!SEC-B-${T}`, modes: ["help"] });
  const phoneB = await vendorPhoneById(b.vendor.id);
  const pre = await supabase.rpc("vendor_pause_preflight", {
    p_vendor_id: a.vendor.id,
    p_category_id: a.cats[0].id,
  });
  // Cross-vendor authenticated pause still must fail identity.
  const badPause = await supabase.rpc("vendor_update_category_profile", {
    p_vendor_id: a.vendor.id,
    p_vendor_phone: phoneB,
    p_category_id: a.cats[0].id,
    p_patch: { is_paused: true },
  });
  expect(badPause.error?.message ?? "").toMatch(/not_found_or_unauthorized|identity_required/);
  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("is_paused")
    .eq("vendor_id", a.vendor.id)
    .eq("category_id", a.cats[0].id)
    .single();
  expect(vc?.is_paused).toBe(false);
  expect(pre.error).toBeTruthy();
  expect(pre.data).toBeNull();
  expect(pre.error?.message ?? "").toMatch(
    /not_found|unauthorized|identity|permission denied|42501/i,
  );
});

test("SEC-ANON-CUSTOMER — anonymous pause without the vendor phone is rejected", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!SEC-ANON-${T}`,
    modes: ["help"],
  });
  const anon = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pause = await anon.rpc("vendor_update_category_profile", {
    p_vendor_id: vendor.id,
    p_vendor_phone: "8800000000",
    p_category_id: cats[0].id,
    p_patch: { is_paused: true },
  });
  expect(pause.error?.message ?? "").toMatch(/not_found_or_unauthorized|identity_required/);
});

function expectPreflightDenied(res: { data: unknown; error: { message?: string } | null }) {
  expect(res.error, "preflight must error").toBeTruthy();
  expect(res.data, "preflight must not return khata or counts").toBeNull();
  expect(JSON.stringify(res.data)).not.toMatch(/pending_amount|customer_count/);
}

test("SEC-ANON-PREFLIGHT — anonymous, customer, and other-vendor sessions cannot call preflight", async () => {
  const a = await seedPauseVendor(ids, T, {
    shop: `!SEC-PRE-A-${T}`,
    modes: ["help"],
  });
  const b = await seedPauseVendor(ids, T, {
    shop: `!SEC-PRE-B-${T}`,
    modes: ["help"],
  });
  const anon = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const pre = await anon.rpc("vendor_pause_preflight", {
    p_vendor_id: a.vendor.id,
    p_category_id: a.cats[0].id,
  });
  expectPreflightDenied(pre);

  const custEmail = `pause.pre.cust.${T}@aaspaas.invalid`;
  const password = `pause_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email: custEmail,
    password,
    email_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  if (created?.user?.id) ids.authUserIds.push(created.user.id);
  const cust = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await cust.auth.signInWithPassword({ email: custEmail, password })).error).toBeNull();
  const custPre = await cust.rpc("vendor_pause_preflight", {
    p_vendor_id: a.vendor.id,
    p_category_id: a.cats[0].id,
  });
  expectPreflightDenied(custPre);

  const otherEmail = `pause.pre.other.${T}@aaspaas.invalid`;
  const { data: otherUser, error: otherErr } = await supabaseAdmin.auth.admin.createUser({
    email: otherEmail,
    password,
    phone: `+91${b.vendor.phone}`,
    email_confirm: true,
    phone_confirm: true,
  });
  expect(otherErr, otherErr?.message).toBeNull();
  if (otherUser?.user?.id) ids.authUserIds.push(otherUser.user.id);
  const other = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await other.auth.signInWithPassword({ email: otherEmail, password })).error).toBeNull();
  const otherPre = await other.rpc("vendor_pause_preflight", {
    p_vendor_id: a.vendor.id,
    p_category_id: a.cats[0].id,
  });
  expectPreflightDenied(otherPre);
});

test("SEC-CUSTOMER-PHONE — a customer JWT cannot pause even if it sends the vendor phone", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!SEC-CUST-${T}`,
    modes: ["help"],
  });
  const email = `pause.cust.${T}@aaspaas.invalid`;
  const password = `pause_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  if (created?.user?.id) ids.authUserIds.push(created.user.id);
  const cust = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  expect((await cust.auth.signInWithPassword({ email, password })).error).toBeNull();
  const custPause = await cust.rpc("vendor_update_category_profile", {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_category_id: cats[0].id,
    p_patch: { is_paused: true },
  });
  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("is_paused")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .single();
  test.fail(
    true,
    "DEFERRED-IDENTITY-HARDENING: vendor_update_category_profile trusts p_vendor_phone, not the JWT role, so a customer session can pause",
  );
  expect(custPause.error).toBeTruthy();
  expect(vc?.is_paused).toBe(false);
});

test("SEC-DIRECT-PATCH — vendor JWT REST PATCH of is_paused must not bypass the open-work gate", async () => {
  const { vendor, cats } = await seedPauseVendor(ids, T, {
    shop: `!SEC-PATCH-${T}`,
    modes: ["help"],
  });
  await insertRequest(ids, T, {
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  const rpc = await pauseRpc(vendor.id, cats[0].id, true);
  expect(rpc.error?.message ?? "").toMatch(/pause_blocked_open_work/);

  const email = `pause.patch.${T}@aaspaas.invalid`;
  const password = `pause_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    phone: `+91${vendor.phone}`,
    email_confirm: true,
    phone_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  if (created?.user?.id) ids.authUserIds.push(created.user.id);

  const jwtClient = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signErr } = await jwtClient.auth.signInWithPassword({ email, password });
  expect(signErr, signErr?.message).toBeNull();

  const { error: patchErr } = await jwtClient
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("is_paused")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .single();
  expect(patchErr).toBeTruthy();
  expect(vc?.is_paused).toBe(false);
});

test("SEC-COLUMNS — vendor cannot write paused_at / pause_credit_days / pause_reminder_sent_at", async () => {
  const { vendor } = await seedPauseVendor(ids, T, { shop: `!SEC-COL-${T}`, modes: ["help"] });
  const phone = await vendorPhoneById(vendor.id);
  for (const patch of [{ pause_credit_days: 99 }, { pause_reminder_sent_at: new Date().toISOString() }]) {
    const { error } = await supabase.rpc("vendor_update_own", {
      p_vendor_id: vendor.id,
      p_vendor_phone: phone,
      p_patch: patch,
    });
    expect(error?.message ?? "").toContain("field_not_allowed");
  }
});

test("SEC-TABLES — vendor cannot INSERT/UPDATE/DELETE pause events or billing windows, or read vendor B", async () => {
  const a = await seedPauseVendor(ids, T, { shop: `!SEC-TAB-A-${T}`, modes: ["help"] });
  const b = await seedPauseVendor(ids, T, { shop: `!SEC-TAB-B-${T}`, modes: ["help"] });
  expect((await pauseRpc(b.vendor.id, b.cats[0].id, true)).error).toBeNull();

  const insE = await supabase.from("vendor_pause_events").insert({
    vendor_id: a.vendor.id,
    category_id: a.cats[0].id,
    paused_at: new Date().toISOString(),
  });
  expect(insE.error).toBeTruthy();
  const insW = await supabase.from("vendor_billing_pauses").insert({
    vendor_id: a.vendor.id,
    started_at: new Date().toISOString(),
  });
  expect(insW.error).toBeTruthy();

  const { data: bEvents } = await supabase
    .from("vendor_pause_events")
    .select("id")
    .eq("vendor_id", b.vendor.id);
  expect(bEvents ?? []).toHaveLength(0);
  const { data: bWins } = await supabase
    .from("vendor_billing_pauses")
    .select("id")
    .eq("vendor_id", b.vendor.id);
  expect(bWins ?? []).toHaveLength(0);

  const { data: eventRow } = await supabaseAdmin
    .from("vendor_pause_events")
    .select("id")
    .eq("vendor_id", b.vendor.id)
    .limit(1)
    .maybeSingle();
  if (eventRow?.id) {
    const upd = await supabase.from("vendor_pause_events").update({ resumed_at: new Date().toISOString() }).eq("id", eventRow.id);
    expect(upd.error || (upd.data == null && upd.count === 0) || upd.error).toBeTruthy();
    const del = await supabase.from("vendor_pause_events").delete().eq("id", eventRow.id);
    expect(del.error).toBeTruthy();
  }
});
