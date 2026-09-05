/**
 * TEST: hybrid session on get_vendor_deletion_status + vendor_fulfil_order.
 * Verifies D1 hijack blocked with Auth session, D2 own phone ok, D3 OTP-off ok.
 * Usage: node scripts/probes/test-vendor-session-hybrid-missed.mjs
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
const phoneA = `98306${String(T).slice(-5)}`;
const phoneB = `98307${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;
const custB = `88017${String(T).slice(-5)}`;
const custA = `88018${String(T).slice(-5)}`;

let vendorA = null;
let vendorB = null;
let reqB = null;
let reqA = null;
let reqB2 = null;
let billIds = [];
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
      name: `MissSess ${tag} ${T}`,
      shop_name: `!MISSSESS-${tag}-${T}`,
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

async function seedRequest(vendorId, userPhone, status = "accepted") {
  const { data, error } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `misssess-${userPhone}`,
      message: "missed hybrid session probe",
      status,
      service_mode: "delivery",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed request: ${error?.message}`);
  return data.id;
}

async function seedBill(requestId, vendorId, userPhone) {
  const { data, error } = await admin
    .from("order_bills")
    .insert({
      request_id: requestId,
      vendor_id: vendorId,
      user_phone: userPhone,
      total_amount: 25,
      payment_mode: "cash",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed bill: ${error?.message}`);
  billIds.push(data.id);
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

  reqB = await seedRequest(vendorB.id, custB, "accepted");
  reqA = await seedRequest(vendorA.id, custA, "accepted");
  reqB2 = await seedRequest(vendorB.id, custB, "accepted");
  await seedBill(reqB, vendorB.id, custB);
  await seedBill(reqA, vendorA.id, custA);
  await seedBill(reqB2, vendorB.id, custB);

  const noSession = createClient(url, anon, { auth: { persistSession: false } });
  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  // D1: session A cannot act as vendor B
  const d1del = await asA.rpc("get_vendor_deletion_status", { p_phone: phoneB });
  const d1fulfil = await asA.rpc("vendor_fulfil_order", {
    p_request_id: reqB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: reqBAfterD1 } = await admin.from("requests").select("status").eq("id", reqB).single();

  // D2: session A can act as vendor A
  const d2del = await asA.rpc("get_vendor_deletion_status", { p_phone: phoneA });
  const d2fulfil = await asA.rpc("vendor_fulfil_order", {
    p_request_id: reqA,
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
  });
  const { data: reqAAfter } = await admin.from("requests").select("status").eq("id", reqA).single();

  // D3: no session (OTP-off) still works with phone ownership
  const d3del = await noSession.rpc("get_vendor_deletion_status", { p_phone: phoneB });
  const d3fulfil = await noSession.rpc("vendor_fulfil_order", {
    p_request_id: reqB2,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: reqB2After } = await admin.from("requests").select("status").eq("id", reqB2).single();

  const report = {
    d1_sessionA_deletion_B: { error: msg(d1del.error), data: d1del.data },
    d1_sessionA_fulfil_B: { error: msg(d1fulfil.error), status: reqBAfterD1?.status },
    d2_sessionA_deletion_A: { error: msg(d2del.error), data: d2del.data },
    d2_sessionA_fulfil_A: { error: msg(d2fulfil.error), status: reqAAfter?.status },
    d3_no_session_deletion_B: { error: msg(d3del.error), data: d3del.data },
    d3_no_session_fulfil_B: { error: msg(d3fulfil.error), status: reqB2After?.status },
  };
  console.log(JSON.stringify(report, null, 2));

  const d1ok =
    isUnauthorized(d1del.error) &&
    isUnauthorized(d1fulfil.error) &&
    reqBAfterD1?.status === "accepted";
  const d2ok =
    !d2del.error &&
    Array.isArray(d2del.data) &&
    d2del.data[0]?.vendor_id === vendorA.id &&
    !d2fulfil.error &&
    reqAAfter?.status === "fulfilled";
  const d3ok =
    !d3del.error &&
    Array.isArray(d3del.data) &&
    d3del.data[0]?.vendor_id === vendorB.id &&
    !d3fulfil.error &&
    reqB2After?.status === "fulfilled";

  if (!d1ok || !d2ok || !d3ok) {
    console.error("OVERALL: FAIL", { d1ok, d2ok, d3ok });
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  for (const id of billIds) {
    await admin.from("order_bills").delete().eq("id", id);
  }
  for (const id of [reqA, reqB, reqB2]) {
    if (id) await admin.from("requests").delete().eq("id", id);
  }
  if (vendorA) await admin.from("vendors").delete().eq("id", vendorA.id);
  if (vendorB) await admin.from("vendors").delete().eq("id", vendorB.id);
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  }
}
