/**
 * TEST probe: confirm_upi_payment self-confirmation gate.
 * Usage: node scripts/probes/test-upi-self-confirmation.mjs
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
const client = createClient(url, anon, { auth: { persistSession: false } });
const stamp = Date.now();
const CUSTOMER_DEVICE = `cust-dev-${stamp}`;
const VENDOR_DEVICE = `vend-dev-${stamp}`;
const UTR = "123456789012";

function rpcError(err) {
  if (!err) return { ok: true, code: null, message: null };
  return { ok: false, code: err.code ?? null, message: err.message ?? String(err) };
}

async function seedClaimedOrder(deviceId, tag) {
  const phone = `9801${String(stamp).slice(-5)}${tag}`;
  const { data: vendor, error: vErr } = await admin
    .from("vendors")
    .insert({
      name: "SelfConfirm Probe",
      shop_name: `!SCP-${stamp}-${tag}`,
      phone,
      upi_id: `scp-${stamp}@upi`,
      service_mode: "delivery",
      is_active: true,
      is_banned: false,
      profile_status: "complete",
    })
    .select("id, phone")
    .single();
  if (vErr) throw new Error(`seedVendor: ${vErr.message}`);

  const userPhone = `8801${String(stamp).slice(-5)}${tag}`;
  const { data: request, error: rErr } = await admin
    .from("requests")
    .insert({
      vendor_id: vendor.id,
      user_phone: userPhone,
      device_id: deviceId,
      message: `self-confirm probe ${stamp}`,
      status: "fulfilled",
      payment_status: "claimed",
      payment_utr: UTR,
      payment_claimed_at: new Date().toISOString(),
    })
    .select("id, device_id, payment_status")
    .single();
  if (rErr) throw new Error(`seedRequest: ${rErr.message}`);

  const { error: bErr } = await admin.from("order_bills").insert({
    request_id: request.id,
    vendor_id: vendor.id,
    user_phone: userPhone,
    total_amount: 150,
    payment_mode: "upi",
    payment_status: "unpaid",
  });
  if (bErr) throw new Error(`seedBill: ${bErr.message}`);

  return { vendor, request, userPhone };
}

async function cleanup(vendorId, requestId) {
  if (requestId) {
    await admin.from("order_bills").delete().eq("request_id", requestId);
    await admin.from("payment_dispute_events").delete().eq("request_id", requestId);
    await admin.from("requests").delete().eq("id", requestId);
  }
  if (vendorId) await admin.from("vendors").delete().eq("id", vendorId);
}

async function confirmRpc(requestId, vendorPhone, callDeviceId) {
  const withDevice = await client.rpc("confirm_upi_payment", {
    p_request_id: requestId,
    p_vendor_phone: vendorPhone,
    p_device_id: callDeviceId,
  });
  if (
    withDevice.error &&
    /could not find the function|does not exist|PGRST202/i.test(withDevice.error.message)
  ) {
    const without = await client.rpc("confirm_upi_payment", {
      p_request_id: requestId,
      p_vendor_phone: vendorPhone,
    });
    return { ...rpcError(without.error), passed_p_device_id: false, fallback_2arg: true };
  }
  return { ...rpcError(withDevice.error), passed_p_device_id: true, fallback_2arg: false };
}

async function runCase(label, callDeviceId, orderDeviceId) {
  const seeded = await seedClaimedOrder(orderDeviceId, label === "a_legitimate_vendor_device" ? "1" : "2");
  try {
    const rpc = await confirmRpc(seeded.request.id, seeded.vendor.phone, callDeviceId);
    const { data: after } = await admin
      .from("requests")
      .select("payment_status")
      .eq("id", seeded.request.id)
      .single();
    const { data: billAfter } = await admin
      .from("order_bills")
      .select("payment_status")
      .eq("request_id", seeded.request.id)
      .single();
    return {
      label,
      rpc,
      payment_status: after?.payment_status ?? null,
      bill_payment_status: billAfter?.payment_status ?? null,
    };
  } finally {
    await cleanup(seeded.vendor.id, seeded.request.id);
  }
}

const a = await runCase("a_legitimate_vendor_device", VENDOR_DEVICE, CUSTOMER_DEVICE);
const b = await runCase("b_self_confirm_same_device", CUSTOMER_DEVICE, CUSTOMER_DEVICE);

console.log(JSON.stringify({ project: TEST_REF, cases: [a, b] }, null, 2));
