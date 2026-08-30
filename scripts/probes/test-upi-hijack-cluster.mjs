/**
 * TEST-only: UPI-hijack cluster — SMS alert, rate limit, insert_bill phone gate.
 * Usage: node scripts/probes/test-upi-hijack-cluster.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const SMS_VENDOR_PHONE = "9096082707";
const SMS_VENDOR_E164 = `+91${SMS_VENDOR_PHONE}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const exoSid = (process.env.EXOTEL_SID ?? "").trim();
const exoKey = (process.env.EXOTEL_API_KEY ?? "").trim();
const exoToken = (process.env.EXOTEL_API_TOKEN ?? "").trim();

if (!url.includes(TEST_REF) || !anon || !service) {
  console.error("HARD STOP: .env.test is not TEST or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const results = {
  a_update: null,
  a_alert_row: null,
  a_exotel: null,
  b_five_ok: null,
  b_sixth: null,
  c_missing: null,
  c_mismatch: null,
  c_match: null,
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function last4(phone) {
  const d = String(phone ?? "").replace(/\D/g, "");
  return d.slice(-4);
}

async function fetchExotelSms(smsSid) {
  if (!exoSid || !exoKey || !exoToken || !smsSid) return null;
  const auth = Buffer.from(`${exoKey}:${exoToken}`).toString("base64");
  const res = await fetch(
    `https://api.exotel.com/v1/Accounts/${exoSid}/Sms/Messages/${smsSid}.json`,
    { headers: { Authorization: `Basic ${auth}` } },
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const m = parsed?.SMSMessage ?? parsed;
  return {
    http: res.status,
    sid: m?.Sid ?? m?.sid ?? null,
    status: m?.Status ?? m?.status ?? null,
    to: m?.To ?? m?.to ?? null,
    from: m?.From ?? m?.from ?? null,
    bodyPreview: String(m?.Body ?? m?.body ?? "").slice(0, 180),
    dateSent: m?.DateSent ?? m?.date_sent ?? null,
  };
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

// ── A. Legitimate UPI change + real SMS ──────────────────────────────────────
console.log("=== A. Legitimate UPI change + SMS ===");
const { data: smsVendor, error: smsVendorErr } = await admin
  .from("vendors")
  .select("id, phone, upi_id, upi_verified")
  .eq("phone", SMS_VENDOR_PHONE)
  .maybeSingle();
if (smsVendorErr || !smsVendor) {
  console.error("FAIL A: no TEST vendor with phone …" + last4(SMS_VENDOR_PHONE), smsVendorErr?.message);
  process.exit(1);
}

const oldUpi = smsVendor.upi_id ?? null;
const oldVerified = smsVendor.upi_verified ?? null;
const newUpi = `hijack-test-${T}@okaxis`;
const since = new Date().toISOString();

try {
  const { error: updErr } = await admin.rpc("vendor_update_own", {
    p_vendor_id: smsVendor.id,
    p_vendor_phone: SMS_VENDOR_PHONE,
    p_patch: { upi_id: newUpi },
  });
  results.a_update = updErr ? `FAIL: ${updErr.message}` : "ok";
  console.log("vendor_update_own", results.a_update);

  if (updErr) {
    console.error("STOP: UPI update failed");
    process.exit(1);
  }

  const { data: afterUpd } = await admin
    .from("vendors")
    .select("upi_id")
    .eq("id", smsVendor.id)
    .single();
  console.log("saved upi matches new", afterUpd?.upi_id === newUpi);

  const alertRow = await pollAlert(smsVendor.id, since);
  results.a_alert_row = alertRow
    ? {
        to_last4: last4(alertRow.to_phone),
        new_upi_match: alertRow.new_upi === newUpi,
        exotel_sid: alertRow.exotel_sid,
        exotel_status: alertRow.exotel_status,
        error: alertRow.error,
      }
    : "NO_ROW";
  console.log("alert row", results.a_alert_row);

  if (alertRow?.exotel_sid) {
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
      body: JSON.stringify({ lookup_sms_sid: alertRow.exotel_sid }),
    });
    const exo = await lookup.json();
    results.a_exotel = {
      http: lookup.status,
      sid: exo.sid,
      status: exo.status,
      detailed_status: exo.detailed_status,
      to_last4: exo.to_last4,
      from: exo.from,
      body_preview: exo.body_preview,
      date_sent: exo.date_sent,
    };
    console.log("exotel lookup", results.a_exotel);
  } else {
    results.a_exotel = alertRow?.error ? `no_sid error=${alertRow.error}` : "no_sid";
    console.log("exotel", results.a_exotel);
  }
} finally {
  const { error: restoreErr } = await admin
    .from("vendors")
    .update({ upi_id: oldUpi, upi_verified: oldVerified, last_updated: new Date().toISOString() })
    .eq("id", smsVendor.id);
  console.log("restore via direct update (no second SMS)", restoreErr ? restoreErr.message : "ok");
}

// ── B. Rate limit ────────────────────────────────────────────────────────────
console.log("=== B. Rate limit 5/day ===");
const rlPhone = `99108${String(T).slice(-5)}`;
const { data: rlVendor, error: rlInsErr } = await admin
  .from("vendors")
  .insert({
    name: `UPI RL ${T}`,
    shop_name: `!UPI-RL-${T}`,
    phone: rlPhone,
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
if (rlInsErr || !rlVendor) {
  console.error("FAIL B: seed vendor", rlInsErr?.message);
  process.exit(1);
}

const changeErrors = [];
for (let i = 1; i <= 5; i++) {
  const { error } = await admin.rpc("vendor_update_own", {
    p_vendor_id: rlVendor.id,
    p_vendor_phone: rlPhone,
    p_patch: { upi_id: `rl-${T}-${i}@okaxis` },
  });
  changeErrors.push(error?.message ?? "ok");
}
results.b_five_ok = changeErrors;
console.log("changes 1-5", changeErrors);

const { error: sixthErr } = await admin.rpc("vendor_update_own", {
  p_vendor_id: rlVendor.id,
  p_vendor_phone: rlPhone,
  p_patch: { upi_id: `rl-${T}-6@okaxis` },
});
results.b_sixth = sixthErr?.message ?? "UNEXPECTED_SUCCESS";
console.log("change 6", results.b_sixth);

const { data: sixthRow } = await admin
  .from("vendors")
  .select("upi_id")
  .eq("id", rlVendor.id)
  .single();
console.log("upi after 6th attempt", sixthRow?.upi_id);

await admin.from("edge_function_rate_limits").delete().eq("identifier", rlVendor.id).eq("function_name", "vendor_upi_mutate");
await admin.from("vendors").delete().eq("id", rlVendor.id);

// ── C. insert_bill_with_items phone gate ─────────────────────────────────────
console.log("=== C. insert_bill_with_items phone gate ===");
const billPhone = `99109${String(T).slice(-5)}`;
const custPhone = `88109${String(T).slice(-5)}`;
const { data: billVendor, error: billVendErr } = await admin
  .from("vendors")
  .insert({
    name: `UPI Bill ${T}`,
    shop_name: `!UPI-BILL-${T}`,
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
if (billVendErr || !billVendor) {
  console.error("FAIL C: seed vendor", billVendErr?.message);
  process.exit(1);
}
await admin.from("users").upsert({ phone: custPhone, trust_score: 75 }, { onConflict: "phone" });
const { data: req, error: reqErr } = await admin
  .from("requests")
  .insert({
    vendor_id: billVendor.id,
    user_phone: custPhone,
    message: `upi-hijack-bill-${T}`,
    status: "accepted",
    payment_status: "unpaid",
  })
  .select("id")
  .single();
if (reqErr) {
  console.error("FAIL C: seed request", reqErr.message);
  process.exit(1);
}

const missing = await admin.rpc("insert_bill_with_items", {
  p_order_id: req.id,
  p_vendor_id: billVendor.id,
  p_customer_phone: custPhone,
  p_total: 10,
  p_payment_mode: "cash",
  p_payment_status: "unpaid",
  p_notes: null,
  p_items: [{ name: "x", quantity: 1, unit_price: 10, unit: null }],
});
results.c_missing = missing.error?.message ?? "UNEXPECTED_SUCCESS";
console.log("omit p_vendor_phone", results.c_missing);

const mismatch = await admin.rpc("insert_bill_with_items", {
  p_order_id: req.id,
  p_vendor_id: billVendor.id,
  p_vendor_phone: "9999999999",
  p_customer_phone: custPhone,
  p_total: 10,
  p_payment_mode: "cash",
  p_payment_status: "unpaid",
  p_notes: null,
  p_items: [{ name: "x", quantity: 1, unit_price: 10, unit: null }],
});
results.c_mismatch = mismatch.error?.message ?? "UNEXPECTED_SUCCESS";
console.log("mismatch phone", results.c_mismatch);

const match = await admin.rpc("insert_bill_with_items", {
  p_order_id: req.id,
  p_vendor_id: billVendor.id,
  p_vendor_phone: billPhone,
  p_customer_phone: custPhone,
  p_total: 10,
  p_payment_mode: "cash",
  p_payment_status: "unpaid",
  p_notes: null,
  p_items: [{ name: "x", quantity: 1, unit_price: 10, unit: null }],
});
results.c_match = match.error ? match.error.message : match.data ? `ok bill=${match.data}` : "no data";
console.log("matching phone", results.c_match);

await admin.from("order_items").delete().eq("request_id", req.id);
await admin.from("order_bills").delete().eq("request_id", req.id);
await admin.from("requests").delete().eq("id", req.id);
await admin.from("vendors").delete().eq("id", billVendor.id);
await admin.from("users").delete().eq("phone", custPhone);

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ sms_vendor_last4: last4(SMS_VENDOR_PHONE), ...results }, null, 2));

const aSmsOk =
  results.a_update === "ok" &&
  results.a_alert_row &&
  results.a_alert_row !== "NO_ROW" &&
  results.a_alert_row.exotel_sid &&
  typeof results.a_exotel === "object" &&
  /delivered_to_handset/i.test(String(results.a_exotel.detailed_status ?? ""));
const bOk =
  Array.isArray(results.b_five_ok) &&
  results.b_five_ok.every((x) => x === "ok") &&
  String(results.b_sixth).includes("rate_limited");
const cOk =
  String(results.c_missing).includes("identity_required") &&
  String(results.c_mismatch).includes("not_found_or_unauthorized") &&
  String(results.c_match).startsWith("ok");

if (!aSmsOk || !bOk || !cOk) {
  console.error("OVERALL: FAIL", { aSmsOk, bOk, cOk });
  process.exit(2);
}
console.log("OVERALL: PASS");
