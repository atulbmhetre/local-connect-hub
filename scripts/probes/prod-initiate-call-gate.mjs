/**
 * PROD probe for initiate-call ownership gate.
 * Usage: node scripts/probes/prod-initiate-call-gate.mjs
 *
 * Places a real Exotel call only for the controlled pair (8888169446 ↔ 9096082707).
 * Live customer/vendor orders are inspected for gate-match only — never dialed.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const PROD_REF = "rpxsyeqskvhjmbkxnpmd";
// PROD: 9096082707 is not a vendor. Reverse pair used in the prior PROD gate test.
const CUSTOMER = "9096082707";
const VENDOR = "8888169446";
const UNRELATED_A = "7000000001";
const UNRELATED_B = "7000000002";
const ACTIVE = ["sent", "seen", "accepted"];
const SEVEN_DAYS_ISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test.prod"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!url.includes(PROD_REF)) {
  console.error("HARD STOP: VITE_SUPABASE_URL is not PROD", url);
  process.exit(1);
}
if (!anon || !service) {
  console.error("HARD STOP: missing anon or service role key in .env.test.prod");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });

function last10(phone) {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}
function last4(phone) {
  return last10(phone).slice(-4);
}

async function postInitiateCall(caller, vendor) {
  const res = await fetch(`${url}/functions/v1/initiate-call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${anon}`,
      apikey: anon,
    },
    body: JSON.stringify({
      caller_phone: caller,
      vendor_phone: vendor,
      service_mode: "help",
    }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

const { data: cat, error: catErr } = await admin.from("categories").select("id").limit(1);
if (catErr) {
  console.error("REST unhealthy", catErr);
  process.exit(1);
}
console.log("REST ok, categories sample:", cat?.length ?? 0);
console.log("target:", url);

const { data: liveRows, error: liveErr } = await admin
  .from("requests")
  .select("id, status, created_at, user_phone, vendor_id, vendors(phone, shop_name)")
  .in("status", ACTIVE)
  .gte("created_at", SEVEN_DAYS_ISO)
  .not("user_phone", "is", null)
  .order("created_at", { ascending: false })
  .limit(25);

if (liveErr) {
  console.error("live orders lookup failed", liveErr);
  process.exit(1);
}

const livePassable = (liveRows ?? []).filter((r) => {
  const cust = last10(r.user_phone);
  const vend = last10(r.vendors?.phone);
  return cust.length === 10 && vend.length === 10 && cust !== vend;
});

console.log("\n--- LIVE AI BRIDGE GATE INSPECTION (no dial) ---");
console.log("in-progress requests last 7d with customer phone:", (liveRows ?? []).length);
console.log("of those, pair would pass ownership gate:", livePassable.length);
if (livePassable[0]) {
  const s = livePassable[0];
  console.log("sample live order (last4 only):", {
    id: s.id,
    status: s.status,
    created_at: s.created_at,
    customer_last4: last4(s.user_phone),
    vendor_last4: last4(s.vendors?.phone),
  });
} else {
  console.log("no live in-progress customer-vendor pairs found in last 7d");
}

const { data: vendorRows, error: vErr } = await admin
  .from("vendors")
  .select("id, phone, shop_name")
  .like("phone", `%${last10(VENDOR)}`);
if (vErr) {
  console.error("vendor lookup failed", vErr);
  process.exit(1);
}
const vendorMatch = (vendorRows ?? []).filter((v) => last10(v.phone) === last10(VENDOR));
console.log("\ncontrolled vendor 8888169446 rows:", vendorMatch.length, vendorMatch[0]?.id ?? null);

let seededId = null;
let existing = null;
if (vendorMatch.length) {
  const { data: reqs, error: rErr } = await admin
    .from("requests")
    .select("id, status, created_at, user_phone, vendor_id")
    .in(
      "vendor_id",
      vendorMatch.map((v) => v.id),
    )
    .in("status", ACTIVE)
    .like("user_phone", `%${last10(CUSTOMER)}`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (rErr) {
    console.error("requests lookup failed", rErr);
    process.exit(1);
  }
  existing =
    (reqs ?? []).find((r) => {
      if (last10(r.user_phone) !== last10(CUSTOMER)) return false;
      const created = new Date(r.created_at).getTime();
      return Number.isFinite(created) && Date.now() - created < 7 * 24 * 60 * 60 * 1000;
    }) ?? null;
}

if (existing) {
  console.log("existing in-progress controlled request:", {
    id: existing.id,
    status: existing.status,
    created_at: existing.created_at,
  });
} else if (vendorMatch.length) {
  const { data: seeded, error: sErr } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorMatch[0].id,
      user_phone: CUSTOMER,
      device_id: "initiate-call-gate-prod-probe",
      message: "initiate-call PROD gate probe (delete after)",
      status: "accepted",
      service_mode: "help",
    })
    .select("id, status, created_at")
    .single();
  if (sErr) {
    console.error("seed failed", sErr);
    process.exit(1);
  }
  seededId = seeded.id;
  console.log("seeded accepted request:", seeded);
} else {
  console.error("no vendor 8888169446 on PROD — cannot run legitimate dial");
}

console.log("\n--- ILLEGITIMATE (unrelated phones) ---");
const bad = await postInitiateCall(UNRELATED_A, UNRELATED_B);
console.log(JSON.stringify(bad, null, 2));

if (existing || seededId) {
  console.log("\n--- LEGITIMATE (9096082707 customer → 8888169446 vendor) ---");
  const good = await postInitiateCall(CUSTOMER, VENDOR);
  console.log(JSON.stringify(good, null, 2));
}

if (seededId) {
  const { error: dErr } = await admin.from("requests").delete().eq("id", seededId);
  console.log(dErr ? `seed cleanup failed: ${dErr.message}` : `cleaned seeded request ${seededId}`);
}
