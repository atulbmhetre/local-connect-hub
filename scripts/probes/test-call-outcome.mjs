/**
 * TEST: seed order, place Exotel connect, wait for StatusCallback row.
 * Usage: node scripts/probes/test-call-outcome.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const CUSTOMER = "8888169446";
const VENDOR = "9096082707";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const callbackToken = fs
  .readFileSync(path.join(root, ".env.test.callback-secret.local"), "utf8")
  .trim();

if (!url.includes(TEST_REF) || !anon || !service || !callbackToken) {
  console.error("HARD STOP: .env.test is not TEST or missing keys/callback secret");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });

function last10(phone) {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

const unauth = await fetch(`${url}/functions/v1/exotel-call-status`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ Status: "completed", CallSid: "probe-unauth" }),
});
console.log("unauth callback status (expect 401):", unauth.status, await unauth.text());

const multipart = new FormData();
multipart.set("CallSid", "multipart-persist-probe");
multipart.set("Status", "completed");
multipart.set("To", VENDOR);
multipart.set("CustomField", `00000000-0000-4000-8000-000000000000|${VENDOR}`);
multipart.set("ConversationDuration", "4");
const multiRes = await fetch(
  `${url}/functions/v1/exotel-call-status?token=${encodeURIComponent(callbackToken)}`,
  { method: "POST", body: multipart },
);
console.log("multipart persist", multiRes.status, await multiRes.text());

const { data: vendorRows, error: vErr } = await admin
  .from("vendors")
  .select("id, phone")
  .like("phone", `%${last10(VENDOR)}`);
if (vErr) {
  console.error(vErr);
  process.exit(1);
}
const vendor = (vendorRows ?? []).find((v) => last10(v.phone) === last10(VENDOR));
if (!vendor) {
  console.error("no TEST vendor 9096082707");
  process.exit(1);
}

const { data: seeded, error: sErr } = await admin
  .from("requests")
  .insert({
    vendor_id: vendor.id,
    user_phone: CUSTOMER,
    device_id: "call-outcome-probe",
    message: "call-outcome TEST probe (delete after)",
    status: "accepted",
    service_mode: "help",
  })
  .select("id")
  .single();
if (sErr) {
  console.error("seed failed", sErr);
  process.exit(1);
}
console.log("seeded request", seeded.id);

const started = Date.now();
const res = await fetch(`${url}/functions/v1/initiate-call`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${anon}`,
    apikey: anon,
  },
  body: JSON.stringify({
    caller_phone: CUSTOMER,
    vendor_phone: VENDOR,
    service_mode: "help",
  }),
});
const callBody = await res.json();
console.log("initiate-call", res.status, callBody);

let row = null;
if (res.ok && callBody.call_sid) {
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const { data } = await admin
      .from("vendor_call_outcomes")
      .select("id, request_id, vendor_phone, call_sid, status, duration_seconds, conversation_duration_seconds, created_at")
      .eq("call_sid", callBody.call_sid)
      .maybeSingle();
    if (data) {
      row = data;
      console.log(`callback row after ${Math.round((Date.now() - started) / 1000)}s`, data);
      break;
    }
    console.log(`waiting callback ${i + 1}/48 ...`);
  }
}

const { error: dErr } = await admin.from("requests").delete().eq("id", seeded.id);
console.log(dErr ? `seed cleanup failed: ${dErr.message}` : `cleaned seed ${seeded.id}`);

if (!row) {
  const sid = callBody.call_sid;
  const exoSid = (process.env.EXOTEL_SID ?? "").trim();
  const exoKey = (process.env.EXOTEL_API_KEY ?? "").trim();
  const exoToken = (process.env.EXOTEL_API_TOKEN ?? "").trim();
  if (sid && exoSid && exoKey && exoToken) {
    const details = await fetch(
      `https://api.exotel.com/v1/Accounts/${exoSid}/Calls/${sid}.json`,
      { headers: { Authorization: `Basic ${Buffer.from(`${exoKey}:${exoToken}`).toString("base64")}` } },
    );
    console.error("exotel call details", details.status, (await details.text()).slice(0, 1200));
  }
  const { data: recent } = await admin
    .from("vendor_call_outcomes")
    .select("call_sid, status, vendor_phone, created_at")
    .order("created_at", { ascending: false })
    .limit(8);
  console.error("recent outcome rows", recent);
  console.error("FAIL: no vendor_call_outcomes row for", sid ?? "(no call_sid)");
  process.exit(1);
}
console.log("PASS: callback captured");
