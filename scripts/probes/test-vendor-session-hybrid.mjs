/**
 * TEST: hybrid session identity on bucket-1 financial RPCs.
 * Usage: node scripts/probes/test-vendor-session-hybrid.mjs
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
const phoneA = `98106${String(T).slice(-5)}`;
const phoneB = `98107${String(T).slice(-5)}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;

let vendorA = null;
let vendorB = null;
let billB = null;
let requestB = null;
let userAId = null;

function msg(err) {
  return err?.message ?? null;
}

async function seedVendor(phone, tag) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `Sess ${tag} ${T}`,
      shop_name: `!SESS-${tag}-${T}`,
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

  const { data: req, error: reqErr } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorB.id,
      user_phone: `88006${String(T).slice(-5)}`,
      device_id: `sess-cust-${T}`,
      message: "session hybrid probe",
      status: "accepted",
      service_mode: "delivery",
    })
    .select("id")
    .single();
  if (reqErr || !req) throw new Error(`seed request: ${reqErr?.message}`);
  requestB = req.id;

  const { data: bill, error: billErr } = await admin
    .from("order_bills")
    .insert({
      request_id: requestB,
      vendor_id: vendorB.id,
      user_phone: `88006${String(T).slice(-5)}`,
      total_amount: 50,
      payment_mode: "cash",
      payment_status: "unpaid",
    })
    .select("id, payment_status")
    .single();
  if (billErr || !bill) throw new Error(`seed bill: ${billErr?.message}`);
  billB = bill.id;

  const anonNoSession = createClient(url, anon, { auth: { persistSession: false } });

  const d4 = await anonNoSession.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterD4 } = await admin
    .from("order_bills")
    .select("payment_status")
    .eq("id", billB)
    .single();

  await admin.from("order_bills").update({ payment_status: "unpaid", paid_at: null }).eq("id", billB);

  const d4void = await anonNoSession.rpc("vendor_void_unpaid_bills", {
    p_request_id: requestB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterVoid } = await admin
    .from("order_bills")
    .select("payment_status")
    .eq("id", billB)
    .single();

  await admin.from("order_bills").update({ payment_status: "unpaid" }).eq("id", billB);

  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d3mark = await asA.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterD3 } = await admin
    .from("order_bills")
    .select("payment_status")
    .eq("id", billB)
    .single();

  const d3add = await asA.rpc("add_bill_to_khata", {
    p_bill_id: billB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });

  const d3param = await asA.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneB,
  });

  const d3ownMissing = await asA.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorA.id,
    p_vendor_phone: phoneA,
  });

  const report = {
    d4_no_session_mark_paid: { error: msg(d4.error), bill: afterD4?.payment_status },
    d4_no_session_void: { error: msg(d4void.error), bill: afterVoid?.payment_status },
    d3_sessionA_as_B_mark: { error: msg(d3mark.error), bill: afterD3?.payment_status },
    d3_sessionA_as_B_khata: { error: msg(d3add.error) },
    d3_sessionA_own_id_B_phone: { error: msg(d3param.error) },
    d3_sessionA_own_phone_B_bill: { error: msg(d3ownMissing.error) },
  };
  console.log(JSON.stringify(report, null, 2));

  const d4ok = !d4.error && afterD4?.payment_status === "paid";
  const d4voidOk = !d4void.error && afterVoid?.payment_status === "void";
  const d3blocked =
    String(msg(d3mark.error) ?? "").includes("not_found_or_unauthorized") &&
    afterD3?.payment_status === "unpaid";
  const d3khataBlocked = String(msg(d3add.error) ?? "").includes("not_found_or_unauthorized");
  const d3paramBlocked = String(msg(d3param.error) ?? "").includes("not_found_or_unauthorized");
  const d3ownMiss = String(msg(d3ownMissing.error) ?? "").includes("not_found_or_unauthorized");

  if (!d4ok || !d4voidOk || !d3blocked || !d3khataBlocked || !d3paramBlocked || !d3ownMiss) {
    console.error("OVERALL: FAIL");
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (billB) await admin.from("order_bills").delete().eq("id", billB);
  if (requestB) await admin.from("requests").delete().eq("id", requestB);
  if (vendorA) await admin.from("vendors").delete().eq("id", vendorA.id);
  if (vendorB) await admin.from("vendors").delete().eq("id", vendorB.id);
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  } else {
    const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const hit = listed?.users?.find((u) => (u.email ?? "") === emailA);
    if (hit?.id) await admin.auth.admin.deleteUser(hit.id).catch(() => {});
  }
}
