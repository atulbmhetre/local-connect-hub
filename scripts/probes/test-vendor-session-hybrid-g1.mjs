/**
 * TEST: hybrid session identity on Group 1 profile/UPI RPCs.
 * Also confirms rate-limit + SMS alert still fire after the additive check.
 * Usage: node scripts/probes/test-vendor-session-hybrid-g1.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(TEST_REF) || !anon || !service) {
  console.error("HARD STOP: .env.test is not TEST or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const phoneA = `98226${String(T).slice(-5)}`;
const phoneB = `98227${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;

let vendorA = null;
let vendorB = null;
let userAId = null;

function msg(err) {
  return err?.message ?? null;
}

function isUnauthorized(err) {
  return String(msg(err) ?? "").includes("not_found_or_unauthorized");
}

function isRateLimited(err) {
  return String(msg(err) ?? "").includes("rate_limited");
}

async function seedVendor(phone, tag) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `G1Sess ${tag} ${T}`,
      shop_name: `!G1SESS-${tag}-${T}`,
      phone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
    })
    .select("id, phone, upi_id")
    .single();
  if (error || !data) throw new Error(`seed vendor ${tag}: ${error?.message}`);
  return data;
}

const emptyCats = {
  p_category_ids: [],
  p_category_service_modes: [],
  p_category_modes: {},
};

try {
  vendorA = await seedVendor(phoneA, "A");
  vendorB = await seedVendor(phoneB, "B");

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: emailA,
    phone: `+91${phoneA}`,
    email_confirm: true,
    phone_confirm: true,
    password: passwordA,
  });
  if (createErr && !/already|exists|registered/i.test(createErr.message)) {
    throw new Error(`createUser A: ${createErr.message}`);
  }
  userAId = created?.user?.id ?? null;

  const noSession = createClient(url, anon, { auth: { persistSession: false } });
  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d1own = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_patch: { upi_id: `hijack-${T}@okaxis` },
  });
  const { data: bAfterD1 } = await admin.from("vendors").select("upi_id").eq("id", vendorB.id).single();

  const d1verify = await asA.rpc("vendor_verify_upi", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_upi_id: `verify-hijack-${T}@okaxis`,
  });

  const d1cats = await asA.rpc("vendor_update_categories", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    ...emptyCats,
  });

  const d1wrap = await asA.rpc("vendor_update_profile_and_categories", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_patch: { upi_id: `wrap-hijack-${T}@okaxis` },
    ...emptyCats,
  });

  const d2own = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_patch: { last_updated: new Date().toISOString() },
  });

  const d3own = await noSession.rpc("vendor_update_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_patch: { last_updated: new Date().toISOString() },
  });

  const smsSince = new Date().toISOString();
  const firstUpi = `g1-rl-${T}-1@okaxis`;
  const d2upi = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_patch: { upi_id: firstUpi },
  });

  let alertRow = null;
  const alertDeadline = Date.now() + 25000;
  while (Date.now() < alertDeadline) {
    const { data } = await admin
      .from("upi_change_alerts")
      .select("id, vendor_id, new_upi, exotel_sid, error")
      .eq("vendor_id", vendorA.id)
      .gte("created_at", smsSince)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      alertRow = data;
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  const d2verify = await asA.rpc("vendor_verify_upi", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_upi_id: firstUpi,
  });

  const rl = [];
  for (let i = 3; i <= 5; i++) {
    const { error } = await asA.rpc("vendor_update_own", {
      p_vendor_id: vendorA.id,
      p_vendor_phone: phoneA,
      p_patch: { upi_id: `g1-rl-${T}-${i}@okaxis` },
    });
    rl.push(error?.message ?? "ok");
  }
  const sixth = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_patch: { upi_id: `g1-rl-${T}-6@okaxis` },
  });
  const { data: afterSixth } = await admin.from("vendors").select("upi_id").eq("id", vendorA.id).single();
  const gpsAfter = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_patch: { last_updated: new Date().toISOString() },
  });

  const report = {
    d1_sessionA_own_B: { error: msg(d1own.error), upi: bAfterD1?.upi_id ?? null },
    d1_sessionA_verify_B: { error: msg(d1verify.error) },
    d1_sessionA_cats_B: { error: msg(d1cats.error) },
    d1_sessionA_wrap_B: { error: msg(d1wrap.error) },
    d2_sessionA_own_A: { error: msg(d2own.error) },
    d2_sessionA_verify_A: { error: msg(d2verify.error) },
    d3_no_session_own_B: { error: msg(d3own.error) },
    sms_alert: alertRow
      ? { new_upi_match: alertRow.new_upi === firstUpi, has_row: true, error: alertRow.error ?? null }
      : { has_row: false },
    first_upi: msg(d2upi.error) ?? "ok",
    rl_3_to_5: rl,
    sixth: msg(sixth.error),
    upi_after_sixth: afterSixth?.upi_id,
    gps_after_limit: msg(gpsAfter.error) ?? "ok",
  };
  console.log(JSON.stringify(report, null, 2));

  const d1ok =
    isUnauthorized(d1own.error) &&
    !bAfterD1?.upi_id &&
    isUnauthorized(d1verify.error) &&
    isUnauthorized(d1cats.error) &&
    isUnauthorized(d1wrap.error);
  const d2ok = !d2own.error && !d2upi.error && !d2verify.error;
  const d3ok = !d3own.error;
  const rlOk =
    rl.every((x) => x === "ok") &&
    isRateLimited(sixth.error) &&
    afterSixth?.upi_id === `g1-rl-${T}-5@okaxis` &&
    !gpsAfter.error;
  const smsOk = Boolean(alertRow) && alertRow.new_upi === firstUpi;

  if (!d1ok || !d2ok || !d3ok || !rlOk || !smsOk) {
    console.error("OVERALL: FAIL", { d1ok, d2ok, d3ok, rlOk, smsOk });
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (vendorA) {
    await admin.from("upi_change_alerts").delete().eq("vendor_id", vendorA.id);
    await admin.from("edge_function_rate_limits").delete().eq("identifier", vendorA.id).eq("function_name", "vendor_upi_mutate");
    await admin.from("vendors").delete().eq("id", vendorA.id);
  }
  if (vendorB) {
    await admin.from("upi_change_alerts").delete().eq("vendor_id", vendorB.id);
    await admin.from("vendors").delete().eq("id", vendorB.id);
  }
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  }
}
