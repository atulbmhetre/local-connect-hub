/**
 * TEST: hybrid session identity on bucket-3 reads + reversible edits.
 * Usage: node scripts/probes/test-vendor-session-hybrid-b3.mjs
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
const phoneA = `98236${String(T).slice(-5)}`;
const phoneB = `98237${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;
const custA = `88036${String(T).slice(-5)}`;
const custB = `88037${String(T).slice(-5)}`;

let vendorA = null;
let vendorB = null;
let reqA = null;
let reqB = null;
let userAId = null;

function msg(err) {
  return err?.message ?? null;
}

function isUnauthorized(err) {
  return String(msg(err) ?? "").includes("not_found_or_unauthorized");
}

async function seedVendor(phone, tag) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `B3Sess ${tag} ${T}`,
      shop_name: `!B3SESS-${tag}-${T}`,
      phone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
    })
    .select("id, phone, shop_name")
    .single();
  if (error || !data) throw new Error(`seed vendor ${tag}: ${error?.message}`);
  return data;
}

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

  const seedReq = async (vendorId, userPhone) => {
    const { data, error } = await admin
      .from("requests")
      .insert({
        vendor_id: vendorId,
        user_phone: userPhone,
        device_id: `b3sess-${userPhone}`,
        message: "bucket3 session probe",
        status: "sent",
        service_mode: "delivery",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed request: ${error?.message}`);
    return data.id;
  };
  reqA = await seedReq(vendorA.id, custA);
  reqB = await seedReq(vendorB.id, custB);

  const noSession = createClient(url, anon, { auth: { persistSession: false } });
  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d1own = await asA.rpc("get_vendor_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const d1incoming = await asA.rpc("get_vendor_incoming_orders", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_limit: 20,
  });
  const d1names = await asA.rpc("get_vendor_customer_names", {
    p_vendor_phone: phoneB,
  });
  const d1menu = await asA.rpc("vendor_insert_menu_items", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_items: [{ name: `hijack-menu-${T}`, price: 10, unit: "pc", sort_order: 0 }],
  });
  const { count: hijackMenu } = await admin
    .from("vendor_menu_items")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorB.id)
    .eq("name", `hijack-menu-${T}`);
  const d1seen = await asA.rpc("vendor_mark_sent_seen", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: reqBAfterD1 } = await admin.from("requests").select("status").eq("id", reqB).single();

  const d2own = await asA.rpc("get_vendor_own", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
  });
  const d2incoming = await asA.rpc("get_vendor_incoming_orders", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_limit: 20,
  });
  const d2names = await asA.rpc("get_vendor_customer_names", {
    p_vendor_phone: phoneA,
  });
  const d2menu = await asA.rpc("vendor_insert_menu_items", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_items: [{ name: `own-menu-${T}`, price: 12, unit: "pc", sort_order: 0 }],
  });
  const { count: ownMenu } = await admin
    .from("vendor_menu_items")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorA.id)
    .eq("name", `own-menu-${T}`);
  const d2seen = await asA.rpc("vendor_mark_sent_seen", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
  });
  const { data: reqAAfter } = await admin.from("requests").select("status").eq("id", reqA).single();

  const d3own = await noSession.rpc("get_vendor_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const d3incoming = await noSession.rpc("get_vendor_incoming_orders", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_limit: 20,
  });
  const d3names = await noSession.rpc("get_vendor_customer_names", {
    p_vendor_phone: phoneB,
  });
  const d3menu = await noSession.rpc("vendor_insert_menu_items", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_items: [{ name: `old-menu-${T}`, price: 8, unit: "pc", sort_order: 0 }],
  });
  const { count: oldMenu } = await admin
    .from("vendor_menu_items")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorB.id)
    .eq("name", `old-menu-${T}`);
  const d3seen = await noSession.rpc("vendor_mark_sent_seen", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: reqBAfterD3 } = await admin.from("requests").select("status").eq("id", reqB).single();

  const ownAName = Array.isArray(d2own.data)
    ? d2own.data[0]?.shop_name
    : d2own.data?.shop_name;
  const ownBName = Array.isArray(d3own.data)
    ? d3own.data[0]?.shop_name
    : d3own.data?.shop_name;
  const incomingALen = Array.isArray(d2incoming.data) ? d2incoming.data.length : 0;
  const incomingBLen = Array.isArray(d3incoming.data) ? d3incoming.data.length : 0;

  const report = {
    d1_sessionA_own_B: { error: msg(d1own.error), data: d1own.data ?? null },
    d1_sessionA_incoming_B: { error: msg(d1incoming.error) },
    d1_sessionA_names_B: { error: msg(d1names.error) },
    d1_sessionA_menu_B: { error: msg(d1menu.error), hijack_rows: hijackMenu ?? 0 },
    d1_sessionA_seen_B: { error: msg(d1seen.error), status: reqBAfterD1?.status },
    d2_sessionA_own_A: { error: msg(d2own.error), shop_name: ownAName ?? null },
    d2_sessionA_incoming_A: { error: msg(d2incoming.error), n: incomingALen },
    d2_sessionA_names_A: { error: msg(d2names.error) },
    d2_sessionA_menu_A: { error: msg(d2menu.error), own_rows: ownMenu ?? 0 },
    d2_sessionA_seen_A: { error: msg(d2seen.error), status: reqAAfter?.status },
    d3_no_session_own_B: { error: msg(d3own.error), shop_name: ownBName ?? null },
    d3_no_session_incoming_B: { error: msg(d3incoming.error), n: incomingBLen },
    d3_no_session_names_B: { error: msg(d3names.error) },
    d3_no_session_menu_B: { error: msg(d3menu.error), old_rows: oldMenu ?? 0 },
    d3_no_session_seen_B: { error: msg(d3seen.error), status: reqBAfterD3?.status },
  };
  console.log(JSON.stringify(report, null, 2));

  const d1ok =
    isUnauthorized(d1own.error) &&
    isUnauthorized(d1incoming.error) &&
    isUnauthorized(d1names.error) &&
    isUnauthorized(d1menu.error) &&
    (hijackMenu ?? 0) === 0 &&
    isUnauthorized(d1seen.error) &&
    reqBAfterD1?.status === "sent";
  const d2ok =
    !d2own.error &&
    ownAName === vendorA.shop_name &&
    !d2incoming.error &&
    incomingALen >= 1 &&
    !d2names.error &&
    !d2menu.error &&
    (ownMenu ?? 0) === 1 &&
    !d2seen.error &&
    reqAAfter?.status === "seen";
  const d3ok =
    !d3own.error &&
    ownBName === vendorB.shop_name &&
    !d3incoming.error &&
    incomingBLen >= 1 &&
    !d3names.error &&
    !d3menu.error &&
    (oldMenu ?? 0) === 1 &&
    !d3seen.error &&
    reqBAfterD3?.status === "seen";

  if (!d1ok || !d2ok || !d3ok) {
    console.error("OVERALL: FAIL", { d1ok, d2ok, d3ok });
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (vendorA) {
    await admin.from("vendor_menu_items").delete().eq("vendor_id", vendorA.id);
  }
  if (vendorB) {
    await admin.from("vendor_menu_items").delete().eq("vendor_id", vendorB.id);
  }
  for (const id of [reqA, reqB]) {
    if (id) await admin.from("requests").delete().eq("id", id);
  }
  if (vendorA) await admin.from("vendors").delete().eq("id", vendorA.id);
  if (vendorB) await admin.from("vendors").delete().eq("id", vendorB.id);
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  }
}
