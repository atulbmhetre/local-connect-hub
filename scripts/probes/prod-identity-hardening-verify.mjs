/**
 * PROD: identity-hardening verification (seeded, always deleted).
 * a) insert_bill_with_items p_vendor_phone gate
 * b) vendor-session-hybrid sample (mark paid, void, update_own)
 * c) UPI-hijack SMS on a temporary vendor using the controlled phone
 *
 * Usage: node scripts/probes/prod-identity-hardening-verify.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const PROD_REF = "rpxsyeqskvhjmbkxnpmd";
const SMS_PHONE = "9096082707";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test.prod"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(PROD_REF) || !anon || !service) {
  console.error("HARD STOP: .env.test.prod is not PROD or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const results = {};

function last4(phone) {
  return String(phone ?? "").replace(/\D/g, "").slice(-4);
}
function msg(err) {
  return err?.message ?? null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollAlert(vendorId, sinceIso, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data, error } = await admin
      .from("upi_change_alerts")
      .select("id, vendor_id, to_phone, new_upi, exotel_sid, exotel_status, error, created_at")
      .eq("vendor_id", vendorId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`upi_change_alerts: ${error.message}`);
    if (data) return data;
    await sleep(2000);
  }
  return null;
}

async function lookupSms(sid) {
  const { data: secretRow } = await admin
    .from("app_config")
    .select("value")
    .eq("key", "upi_alert_hook_secret")
    .maybeSingle();
  const lookup = await fetch(`${url}/functions/v1/notify-upi-change`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anon}`,
      apikey: anon,
      "x-upi-alert-secret": secretRow?.value ?? "",
    },
    body: JSON.stringify({ lookup_sms_sid: sid }),
  });
  const exo = await lookup.json();
  return {
    http: lookup.status,
    sid: exo.sid,
    status: exo.status,
    detailed_status: exo.detailed_status,
    to_last4: exo.to_last4,
    from: exo.from,
    body_preview: exo.body_preview,
    date_sent: exo.date_sent,
    error: exo.error,
  };
}

// ── A. insert_bill_with_items phone gate ────────────────────────────────────
console.log("=== A. insert_bill_with_items phone gate ===");
const billPhone = `99119${String(T).slice(-5)}`;
const custPhone = `88119${String(T).slice(-5)}`;
let billVendorId = null;
let billReqId = null;
try {
  const { data: billVendor, error: billVendErr } = await admin
    .from("vendors")
    .insert({
      name: `PROD BillGate ${T}`,
      shop_name: `!PROD-BILL-${T}`,
      phone: billPhone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
    })
    .select("id")
    .single();
  if (billVendErr || !billVendor) throw new Error(`seed vendor: ${billVendErr?.message}`);
  billVendorId = billVendor.id;

  await admin.from("users").upsert({ phone: custPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data: req, error: reqErr } = await admin
    .from("requests")
    .insert({
      vendor_id: billVendorId,
      user_phone: custPhone,
      message: `prod-bill-gate-${T}`,
      status: "accepted",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (reqErr) throw new Error(`seed request: ${reqErr.message}`);
  billReqId = req.id;

  const items = [{ name: "x", quantity: 1, unit_price: 10, unit: null }];
  const missing = await admin.rpc("insert_bill_with_items", {
    p_order_id: billReqId,
    p_vendor_id: billVendorId,
    p_customer_phone: custPhone,
    p_total: 10,
    p_payment_mode: "cash",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: items,
  });
  results.a_omit = missing.error?.message ?? "UNEXPECTED_SUCCESS";

  const mismatch = await admin.rpc("insert_bill_with_items", {
    p_order_id: billReqId,
    p_vendor_id: billVendorId,
    p_vendor_phone: "9999999999",
    p_customer_phone: custPhone,
    p_total: 10,
    p_payment_mode: "cash",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: items,
  });
  results.a_mismatch = mismatch.error?.message ?? "UNEXPECTED_SUCCESS";

  const match = await admin.rpc("insert_bill_with_items", {
    p_order_id: billReqId,
    p_vendor_id: billVendorId,
    p_vendor_phone: billPhone,
    p_customer_phone: custPhone,
    p_total: 10,
    p_payment_mode: "cash",
    p_payment_status: "unpaid",
    p_notes: null,
    p_items: items,
  });
  results.a_match = match.error ? match.error.message : match.data ? `ok bill=${match.data}` : "no data";
  console.log(JSON.stringify({ omit: results.a_omit, mismatch: results.a_mismatch, match: results.a_match }));
} finally {
  if (billReqId) {
    await admin.from("order_items").delete().eq("request_id", billReqId);
    await admin.from("order_bills").delete().eq("request_id", billReqId);
    await admin.from("requests").delete().eq("id", billReqId);
  }
  if (billVendorId) await admin.from("vendors").delete().eq("id", billVendorId);
  await admin.from("users").delete().eq("phone", custPhone);
}

// ── B. session hybrid sample ────────────────────────────────────────────────
console.log("=== B. vendor-session-hybrid sample ===");
const phoneA = `98116${String(T).slice(-5)}`;
const phoneB = `98117${String(T).slice(-5)}`;
const emailA = `prod+91${phoneA}@aaspaas.invalid`;
const passwordA = `prod_pw_${phoneA}`;
let vendorA = null;
let vendorB = null;
let billB = null;
let requestB = null;
let userAId = null;
try {
  const seedVendor = async (phone, tag) => {
    const { data, error } = await admin
      .from("vendors")
      .insert({
        name: `PROD Sess ${tag} ${T}`,
        shop_name: `!PROD-SESS-${tag}-${T}`,
        phone,
        category: "Test",
        service_mode: "delivery",
        is_active: true,
        profile_status: "complete",
        latitude: 18.52,
        longitude: 73.85,
        service_radius_km: 5,
        upi_id: `prod-sess-${tag}-${T}@okaxis`,
      })
      .select("id, phone")
      .single();
    if (error || !data) throw new Error(`seed vendor ${tag}: ${error?.message}`);
    return data;
  };
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
      user_phone: `88016${String(T).slice(-5)}`,
      device_id: `prod-sess-cust-${T}`,
      message: "prod session hybrid probe",
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
      user_phone: `88016${String(T).slice(-5)}`,
      total_amount: 50,
      payment_mode: "cash",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (billErr || !bill) throw new Error(`seed bill: ${billErr?.message}`);
  billB = bill.id;

  const anonNoSession = createClient(url, anon, { auth: { persistSession: false } });
  const d4mark = await anonNoSession.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterD4 } = await admin.from("order_bills").select("payment_status").eq("id", billB).single();
  await admin.from("order_bills").update({ payment_status: "unpaid", paid_at: null }).eq("id", billB);

  const d4void = await anonNoSession.rpc("vendor_void_unpaid_bills", {
    p_request_id: requestB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterVoid } = await admin.from("order_bills").select("payment_status").eq("id", billB).single();
  await admin.from("order_bills").update({ payment_status: "unpaid" }).eq("id", billB);

  const d4own = await anonNoSession.rpc("vendor_update_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_patch: { shop_name: `!PROD-SESS-B-OK-${T}` },
  });

  const asA = createClient(url, anon, { auth: { persistSession: false } });
  const { error: signErr } = await asA.auth.signInWithPassword({ email: emailA, password: passwordA });
  if (signErr) throw new Error(`signIn A: ${signErr.message}`);

  const d3mark = await asA.rpc("vendor_mark_bill_paid", {
    p_bill_id: billB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });
  const { data: afterD3 } = await admin.from("order_bills").select("payment_status").eq("id", billB).single();

  const d3void = await asA.rpc("vendor_void_unpaid_bills", {
    p_request_id: requestB,
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
  });

  const d3own = await asA.rpc("vendor_update_own", {
    p_vendor_id: vendorB.id,
    p_vendor_phone: phoneB,
    p_patch: { upi_id: `hijack-as-a-${T}@okaxis` },
  });

  results.b = {
    no_session_mark_paid: { error: msg(d4mark.error), bill: afterD4?.payment_status },
    no_session_void: { error: msg(d4void.error), bill: afterVoid?.payment_status },
    no_session_update_own: { error: msg(d4own.error) },
    sessionA_as_B_mark: { error: msg(d3mark.error), bill: afterD3?.payment_status },
    sessionA_as_B_void: { error: msg(d3void.error) },
    sessionA_as_B_update_own: { error: msg(d3own.error) },
  };
  console.log(JSON.stringify(results.b, null, 2));
} finally {
  if (billB) await admin.from("order_bills").delete().eq("id", billB);
  if (requestB) await admin.from("requests").delete().eq("id", requestB);
  if (vendorA) {
    await admin.from("upi_change_alerts").delete().eq("vendor_id", vendorA.id);
    await admin.from("edge_function_rate_limits").delete().eq("identifier", vendorA.id);
    await admin.from("vendors").delete().eq("id", vendorA.id);
  }
  if (vendorB) {
    await admin.from("upi_change_alerts").delete().eq("vendor_id", vendorB.id);
    await admin.from("edge_function_rate_limits").delete().eq("identifier", vendorB.id);
    await admin.from("vendors").delete().eq("id", vendorB.id);
  }
  if (userAId) {
    await admin.auth.admin.deleteUser(userAId).catch(() => {});
  } else {
    const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const hit = listed?.users?.find((u) => (u.email ?? "") === emailA);
    if (hit?.id) await admin.auth.admin.deleteUser(hit.id).catch(() => {});
  }
}

// ── C. UPI-hijack SMS (temp vendor on controlled phone) ───────────────────────
console.log("=== C. UPI-hijack SMS (temp vendor) ===");
let smsVendorId = null;
let displaced = null;
try {
  const { data: existing } = await admin
    .from("vendors")
    .select("id, phone, upi_id")
    .eq("phone", SMS_PHONE)
    .maybeSingle();
  if (existing) {
    displaced = existing;
    const parkPhone = `99118${String(T).slice(-5)}`;
    const { error: parkErr } = await admin
      .from("vendors")
      .update({ phone: parkPhone })
      .eq("id", existing.id);
    if (parkErr) throw new Error(`park live vendor: ${parkErr.message}`);
    displaced.park_phone = parkPhone;
    console.log("parked existing vendor …" + last4(SMS_PHONE), existing.id);
  }

  const { data: smsVendor, error: smsInsErr } = await admin
    .from("vendors")
    .insert({
      name: `PROD UPI SMS ${T}`,
      shop_name: `!PROD-UPI-SMS-${T}`,
      phone: SMS_PHONE,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
      upi_id: `prod-sms-old-${T}@okaxis`,
    })
    .select("id")
    .single();
  if (smsInsErr || !smsVendor) throw new Error(`seed sms vendor: ${smsInsErr?.message}`);
  smsVendorId = smsVendor.id;

  const newUpi = `prod-hijack-${T}@okaxis`;
  const since = new Date().toISOString();
  const { error: updErr } = await admin.rpc("vendor_update_own", {
    p_vendor_id: smsVendorId,
    p_vendor_phone: SMS_PHONE,
    p_patch: { upi_id: newUpi },
  });
  results.c_update = updErr ? `FAIL: ${updErr.message}` : "ok";

  const alertRow = await pollAlert(smsVendorId, since);
  results.c_alert = alertRow
    ? {
        to_last4: last4(alertRow.to_phone),
        new_upi_match: alertRow.new_upi === newUpi,
        exotel_sid: alertRow.exotel_sid,
        exotel_status: alertRow.exotel_status,
        error: alertRow.error,
      }
    : "NO_ROW";

  if (alertRow?.exotel_sid) {
    results.c_exotel = await lookupSms(alertRow.exotel_sid);
  } else {
    results.c_exotel = alertRow?.error ? `no_sid error=${alertRow.error}` : "no_sid";
  }
  console.log(JSON.stringify({ update: results.c_update, alert: results.c_alert, exotel: results.c_exotel }, null, 2));
} finally {
  if (smsVendorId) {
    await admin.from("upi_change_alerts").delete().eq("vendor_id", smsVendorId);
    await admin.from("edge_function_rate_limits").delete().eq("identifier", smsVendorId);
    await admin.from("vendors").delete().eq("id", smsVendorId);
  }
  if (displaced) {
    const { error: restoreErr } = await admin
      .from("vendors")
      .update({ phone: SMS_PHONE })
      .eq("id", displaced.id);
    console.log("restore parked vendor …" + last4(SMS_PHONE), restoreErr ? restoreErr.message : "ok");
  }
}

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(results, null, 2));

const aOk =
  String(results.a_omit).includes("identity_required") &&
  String(results.a_mismatch).includes("not_found_or_unauthorized") &&
  String(results.a_match).startsWith("ok");
const b = results.b ?? {};
const bOk =
  !b.no_session_mark_paid?.error &&
  b.no_session_mark_paid?.bill === "paid" &&
  !b.no_session_void?.error &&
  b.no_session_void?.bill === "void" &&
  !b.no_session_update_own?.error &&
  String(b.sessionA_as_B_mark?.error ?? "").includes("not_found_or_unauthorized") &&
  b.sessionA_as_B_mark?.bill === "unpaid" &&
  String(b.sessionA_as_B_void?.error ?? "").includes("not_found_or_unauthorized") &&
  String(b.sessionA_as_B_update_own?.error ?? "").includes("not_found_or_unauthorized");
const cSmsOk =
  results.c_update === "ok" &&
  results.c_alert &&
  results.c_alert !== "NO_ROW" &&
  results.c_alert.exotel_sid &&
  typeof results.c_exotel === "object" &&
  /delivered_to_handset/i.test(String(results.c_exotel.detailed_status ?? results.c_exotel.status ?? ""));

if (!aOk || !bOk || !cSmsOk) {
  console.error("OVERALL: FAIL", { aOk, bOk, cSmsOk });
  process.exit(2);
}
console.log("OVERALL: PASS");
