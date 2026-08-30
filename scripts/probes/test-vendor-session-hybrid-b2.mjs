/**
 * TEST: hybrid session identity on bucket-2 order-lifecycle / standing RPCs.
 * Usage: node scripts/probes/test-vendor-session-hybrid-b2.mjs
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
const phoneA = `98206${String(T).slice(-5)}`;
const phoneB = `98207${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;
const custB = `88007${String(T).slice(-5)}`;
const custA = `88008${String(T).slice(-5)}`;

let vendorA = null;
let vendorB = null;
let reqB = null;
let reqA = null;
let reqB2 = null;
let billB = null;
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
      name: `B2Sess ${tag} ${T}`,
      shop_name: `!B2SESS-${tag}-${T}`,
      phone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
    })
    .select("id, phone")
    .single();
  if (error || !data) throw new Error(`seed vendor ${tag}: ${error?.message}`);
  return data;
}

async function seedRequest(vendorId, userPhone, status = "sent") {
  const { data, error } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `b2sess-${userPhone}`,
      message: "bucket2 session probe",
      status,
      service_mode: "delivery",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed request: ${error?.message}`);
  return data.id;
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

  reqB = await seedRequest(vendorB.id, custB, "sent");
  reqA = await seedRequest(vendorA.id, custA, "sent");
  reqB2 = await seedRequest(vendorB.id, custB, "seen");

  const { data: bill, error: billErr } = await admin
    .from("order_bills")
    .insert({
      request_id: reqB,
      vendor_id: vendorB.id,
      user_phone: custB,
      total_amount: 40,
      payment_mode: "cash",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (billErr || !bill) throw new Error(`seed bill: ${billErr?.message}`);
  billB = bill.id;

  const noSession = createClient(url, anon, { auth: { persistSession: false } });
  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d1accept = await asA.rpc("vendor_accept_order", {
    p_request_id: reqB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_from_status: "sent",
  });
  const { data: reqBAfterD1 } = await admin.from("requests").select("status").eq("id", reqB).single();

  const d1device = await asA.rpc("upsert_vendor_device", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_device_id: `atk-${T}`,
    p_fcm_token: `fcm-atk-${T}`,
  });
  const { count: deviceHijack } = await admin
    .from("vendor_devices")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendorB.id)
    .eq("device_id", `atk-${T}`);

  const d1remind = await asA.rpc("send_bill_payment_reminder", {
    p_bill_id: billB,
    p_source: "vendor",
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });

  const d1dismiss = await asA.rpc("vendor_dismiss_requests", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_request_ids: [reqB2],
  });
  const { data: reqB2AfterD1 } = await admin.from("requests").select("status").eq("id", reqB2).single();

  const d2accept = await asA.rpc("vendor_accept_order", {
    p_request_id: reqA,
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_from_status: "sent",
  });
  const { data: reqAAfter } = await admin.from("requests").select("status").eq("id", reqA).single();

  const d2device = await asA.rpc("upsert_vendor_device", {
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
    p_device_id: `own-${T}`,
    p_fcm_token: `fcm-own-${T}`,
  });

  const d3accept = await noSession.rpc("vendor_accept_order", {
    p_request_id: reqB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_from_status: "sent",
  });
  const { data: reqBAfterD3 } = await admin.from("requests").select("status").eq("id", reqB).single();

  const d3device = await noSession.rpc("upsert_vendor_device", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_device_id: `old-${T}`,
    p_fcm_token: `fcm-old-${T}`,
  });

  const d3cron = await noSession.rpc("send_bill_payment_reminder", {
    p_bill_id: billB,
    p_source: "cron",
  });

  const report = {
    d1_sessionA_accept_B: { error: msg(d1accept.error), status: reqBAfterD1?.status },
    d1_sessionA_device_B: { error: msg(d1device.error), hijack_rows: deviceHijack ?? 0 },
    d1_sessionA_remind_B: { error: msg(d1remind.error) },
    d1_sessionA_dismiss_B: { error: msg(d1dismiss.error), status: reqB2AfterD1?.status },
    d2_sessionA_accept_A: { error: msg(d2accept.error), data: d2accept.data, status: reqAAfter?.status },
    d2_sessionA_device_A: { error: msg(d2device.error) },
    d3_no_session_accept_B: { error: msg(d3accept.error), data: d3accept.data, status: reqBAfterD3?.status },
    d3_no_session_device_B: { error: msg(d3device.error) },
    d3_no_session_cron_remind: { error: msg(d3cron.error) },
  };
  console.log(JSON.stringify(report, null, 2));

  const d1ok =
    isUnauthorized(d1accept.error) &&
    reqBAfterD1?.status === "sent" &&
    isUnauthorized(d1device.error) &&
    (deviceHijack ?? 0) === 0 &&
    isUnauthorized(d1remind.error) &&
    isUnauthorized(d1dismiss.error) &&
    reqB2AfterD1?.status === "seen";
  const d2ok = !d2accept.error && d2accept.data === true && reqAAfter?.status === "accepted" && !d2device.error;
  const d3ok =
    !d3accept.error &&
    d3accept.data === true &&
    reqBAfterD3?.status === "accepted" &&
    !d3device.error &&
    !isUnauthorized(d3cron.error);

  if (!d1ok || !d2ok || !d3ok) {
    console.error("OVERALL: FAIL", { d1ok, d2ok, d3ok });
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (billB) await admin.from("order_bills").delete().eq("id", billB);
  for (const id of [reqA, reqB, reqB2]) {
    if (id) await admin.from("requests").delete().eq("id", id);
  }
  if (vendorA) {
    await admin.from("vendor_devices").delete().eq("vendor_id", vendorA.id);
    await admin.from("vendors").delete().eq("id", vendorA.id);
  }
  if (vendorB) {
    await admin.from("vendor_devices").delete().eq("vendor_id", vendorB.id);
    await admin.from("vendors").delete().eq("id", vendorB.id);
  }
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  }
}
