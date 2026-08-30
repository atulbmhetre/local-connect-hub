/**
 * TEST-only probe for initiate-call order gate.
 * Usage: node scripts/probes/test-initiate-call-gate.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const CUSTOMER = "8888169446";
const VENDOR = "9096082707";
const UNRELATED_A = "7000000001";
const UNRELATED_B = "7000000002";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!url.includes(TEST_REF)) {
  console.error("HARD STOP: VITE_SUPABASE_URL is not TEST", url);
  process.exit(1);
}
if (!anon || !service) {
  console.error("HARD STOP: missing anon or service role key in .env.test");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });

function last10(phone) {
  return phone.replace(/\D/g, "").slice(-10);
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

const { data: vendorRows, error: vErr } = await admin
  .from("vendors")
  .select("id, phone, shop_name")
  .like("phone", `%${last10(VENDOR)}`);
if (vErr) {
  console.error("vendor lookup failed", vErr);
  process.exit(1);
}
const vendorIds = (vendorRows ?? [])
  .filter((v) => last10(v.phone ?? "") === last10(VENDOR))
  .map((v) => v.id);
console.log("vendor rows matching 9096082707:", vendorIds.length, vendorIds[0] ?? null);

let seededId = null;
let existing = null;
if (vendorIds.length) {
  const { data: reqs, error: rErr } = await admin
    .from("requests")
    .select("id, status, created_at, user_phone, vendor_id")
    .in("vendor_id", vendorIds)
    .in("status", ["sent", "seen", "accepted"])
    .like("user_phone", `%${last10(CUSTOMER)}`)
    .order("created_at", { ascending: false })
    .limit(10);
  if (rErr) {
    console.error("requests lookup failed", rErr);
    process.exit(1);
  }
  existing = (reqs ?? []).find((r) => last10(r.user_phone ?? "") === last10(CUSTOMER)) ?? null;
}

if (existing) {
  console.log("existing in-progress request:", {
    id: existing.id,
    status: existing.status,
    created_at: existing.created_at,
  });
} else if (vendorIds.length) {
  const { data: seeded, error: sErr } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorIds[0],
      user_phone: CUSTOMER,
      device_id: "initiate-call-gate-probe",
      message: "initiate-call gate probe (delete after)",
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
  console.error("no vendor 9096082707 on TEST — cannot run legitimate case");
}

console.log("\n--- ILLEGITIMATE (unrelated phones) ---");
const bad = await postInitiateCall(UNRELATED_A, UNRELATED_B);
console.log(JSON.stringify(bad, null, 2));

if (existing || seededId) {
  console.log("\n--- LEGITIMATE (8888169446 customer → 9096082707 vendor) ---");
  const good = await postInitiateCall(CUSTOMER, VENDOR);
  console.log(JSON.stringify(good, null, 2));
}

if (seededId) {
  const { error: dErr } = await admin.from("requests").delete().eq("id", seededId);
  console.log(dErr ? `seed cleanup failed: ${dErr.message}` : `cleaned seeded request ${seededId}`);
}
