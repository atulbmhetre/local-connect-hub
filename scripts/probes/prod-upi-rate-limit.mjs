/**
 * PROD: UPI mutate rate limit (5/day). Seeded vendor, always deleted.
 * Usage: node scripts/probes/prod-upi-rate-limit.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const PROD_REF = "rpxsyeqskvhjmbkxnpmd";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test.prod"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(PROD_REF) || !service) {
  console.error("HARD STOP: .env.test.prod is not PROD or missing service key");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const phone = `99106${String(T).slice(-5)}`;
let vendorId = null;

try {
  const { data: vendor, error: insErr } = await admin
    .from("vendors")
    .insert({
      name: `UPI RL PROD ${T}`,
      shop_name: `!UPI-RL-PROD-${T}`,
      phone,
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
  if (insErr || !vendor) throw new Error(`seed: ${insErr?.message}`);
  vendorId = vendor.id;

  const firstFive = [];
  for (let i = 1; i <= 5; i++) {
    const { error } = await admin.rpc("vendor_update_own", {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_patch: { upi_id: `prod-rl-${T}-${i}@okaxis` },
    });
    firstFive.push(error?.message ?? "ok");
  }
  const { error: sixthErr } = await admin.rpc("vendor_update_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_patch: { upi_id: `prod-rl-${T}-6@okaxis` },
  });
  const { data: after } = await admin.from("vendors").select("upi_id").eq("id", vendorId).single();

  const { error: gpsErr } = await admin.rpc("vendor_update_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_patch: { last_updated: new Date().toISOString() },
  });

  console.log(
    JSON.stringify(
      {
        first_five: firstFive,
        sixth: sixthErr?.message ?? "UNEXPECTED_SUCCESS",
        upi_after_sixth: after?.upi_id,
        gps_patch_after_limit: gpsErr?.message ?? "ok",
      },
      null,
      2,
    ),
  );

  const fiveOk = firstFive.every((x) => x === "ok");
  const sixthBlocked = String(sixthErr?.message ?? "").includes("rate_limited");
  const sixthRolledBack = after?.upi_id === `prod-rl-${T}-5@okaxis`;
  const gpsOk = !gpsErr;
  if (!fiveOk || !sixthBlocked || !sixthRolledBack || !gpsOk) {
    console.error("OVERALL: FAIL");
    process.exit(2);
  }
  console.log("OVERALL: PASS");
} finally {
  if (vendorId) {
    await admin.from("edge_function_rate_limits").delete().eq("identifier", vendorId).eq("function_name", "vendor_upi_mutate");
    await admin.from("vendors").delete().eq("id", vendorId);
  }
}
