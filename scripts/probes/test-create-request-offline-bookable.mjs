/**
 * TEST/PROD: offline-but-discoverable delivery vendor remains bookable.
 * Usage:
 *   node scripts/probes/test-create-request-offline-bookable.mjs
 *   node scripts/probes/test-create-request-offline-bookable.mjs --prod
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const isProd = process.argv.includes("--prod");
dotenv.config({ path: path.join(root, isProd ? ".env.test.prod" : ".env.test"), override: true });

const expectedRef = isProd ? "rpxsyeqskvhjmbkxnpmd" : "hhdylnhqdzfabsolwxdz";
const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log(`=== ${isProd ? "PROD" : "TEST"} offline bookable ===`);
console.log("project_ref:", ref);
if (ref !== expectedRef || !anonKey || !service) {
  console.error("HARD STOP");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const T = Date.now();
const vendorPhone = `9835${String(T).slice(-6)}`;
const custPhone = `8845${String(T).slice(-6)}`;
const deviceId = `offbook_${T}`;
let vendorId = null;
let requestId = null;
let failed = false;

async function cleanup() {
  if (requestId) await admin.from("requests").delete().eq("id", requestId);
  if (vendorId) {
    await admin.from("vendor_category_modes").delete().eq(
      "vendor_category_id",
      (
        await admin.from("vendor_categories").select("id").eq("vendor_id", vendorId)
      ).data?.[0]?.id ?? "00000000-0000-0000-0000-000000000000",
    );
    await admin.from("vendor_categories").delete().eq("vendor_id", vendorId);
    await admin.from("vendors").delete().eq("id", vendorId);
  }
  await admin.from("users").delete().eq("phone", custPhone);
}

try {
  await admin.from("users").upsert({ phone: custPhone, trust_score: 70 }, { onConflict: "phone" });

  const { data: cats, error: catErr } = await admin
    .from("categories")
    .select("id, label, service_mode")
    .eq("is_active", true)
    .limit(80);
  if (catErr) throw catErr;
  const deliveryCat =
    cats?.find((c) => String(c.service_mode ?? "").toLowerCase() === "delivery") ??
    cats?.find((c) => String(c.service_mode ?? "").toLowerCase().includes("delivery")) ??
    cats?.[0];
  if (!deliveryCat) throw new Error("no delivery category");

  const { data: regId, error: regErr } = await anon.rpc("register_vendor", {
    p_name: `OffBook ${T}`,
    p_shop_name: `!OFFBOOK-${T}`,
    p_category: deliveryCat.label,
    p_phone: vendorPhone,
    p_upi_id: `offbook${String(T).slice(-4)}@upi`,
    p_service_mode: "delivery",
    p_vendor_type: "shop",
    p_vendor_note: `offbook:${T}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `OB${String(T).slice(-6)}`.slice(0, 8),
    p_profile_status: "complete",
    p_category_ids: [deliveryCat.id],
    p_category_service_modes: ["delivery"],
    p_category_modes: { [deliveryCat.id]: ["delivery"] },
    p_base_type: "shop",
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: true,
    p_service_radius_km: 15,
    p_availability_modes: ["delivery"],
  });
  if (regErr || !regId) throw new Error(`register_vendor: ${regErr?.message}`);
  vendorId = regId;

  const { error: offErr } = await admin
    .from("vendors")
    .update({ is_active: false, discoverable: true })
    .eq("id", vendorId);
  if (offErr) throw new Error(`set offline: ${offErr.message}`);

  const deadline = new Date(Date.now() + 4 * 3600_000).toISOString();
  const { data: reqId, error } = await anon.rpc("create_customer_request", {
    p_device_id: deviceId,
    p_vendor_id: vendorId,
    p_message: "offline bookable probe",
    p_user_phone: custPhone,
    p_delivery_address: "probe addr",
    p_delivery_slot: "evening",
    p_delivery_slot_deadline: deadline,
    p_category_id: deliveryCat.id,
    p_service_mode: "delivery",
    p_items: [{ name: "milk", qty: 1, price: 10 }],
  });
  requestId = reqId ?? null;

  if (error || !reqId) {
    failed = true;
    console.log("FAIL offline_discoverable_bookable", {
      rpc: "create_customer_request",
      error: error?.message ?? null,
    });
  } else {
    console.log("PASS offline_discoverable_bookable", {
      rpc: "create_customer_request",
      request_id: reqId,
      vendor_is_active: false,
      vendor_discoverable: true,
    });
  }
} catch (e) {
  failed = true;
  console.error("FATAL", e);
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
