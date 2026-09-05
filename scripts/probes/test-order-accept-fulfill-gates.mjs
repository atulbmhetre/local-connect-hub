/**
 * TEST/PROD: accept + fulfil status gates.
 * Live fulfil RPC: vendor_fulfil_order (IncomingOrdersSection).
 * Usage:
 *   node scripts/probes/test-order-accept-fulfill-gates.mjs
 *   node scripts/probes/test-order-accept-fulfill-gates.mjs --prod
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const isProd = process.argv.includes("--prod");
const envFile = isProd ? ".env.test.prod" : ".env.test";
const expectedRef = isProd ? "rpxsyeqskvhjmbkxnpmd" : "hhdylnhqdzfabsolwxdz";

dotenv.config({ path: path.join(root, envFile), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log(`=== ${isProd ? "PROD" : "TEST"} accept/fulfill status gates ===`);
console.log("project_ref:", ref);
console.log("expected:", expectedRef);

if (ref !== expectedRef || !anonKey || !service) {
  console.error("HARD STOP: wrong env or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const vendorPhone = `9831${String(T).slice(-6)}`;
const custPhone = `8841${String(T).slice(-6)}`;
const created = { vendorId: null, requestIds: [] };

function errMsg(e) {
  return e?.message ?? null;
}

async function cleanup() {
  if (created.requestIds.length) {
    await admin.from("order_bills").delete().in("request_id", created.requestIds);
    await admin.from("requests").delete().in("id", created.requestIds);
  }
  if (created.vendorId) {
    await admin.from("vendor_categories").delete().eq("vendor_id", created.vendorId);
    await admin.from("vendors").delete().eq("id", created.vendorId);
  }
  await admin.from("users").delete().eq("phone", custPhone);
}

async function seedRequest(status) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      vendor_id: created.vendorId,
      user_phone: custPhone,
      device_id: `afg_${T}`,
      message: `accept-fulfill-gate-${status}-${T}`,
      status,
      service_mode: "delivery",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed ${status}: ${error?.message}`);
  created.requestIds.push(data.id);
  return data.id;
}

async function statusOf(id) {
  const { data } = await admin.from("requests").select("status").eq("id", id).single();
  return data?.status ?? null;
}

const results = {};
let failed = false;

function check(name, ok, detail) {
  results[name] = { ok, ...detail };
  if (!ok) failed = true;
  console.log(ok ? `PASS ${name}` : `FAIL ${name}`, detail);
}

try {
  await admin.from("users").upsert({ phone: custPhone, trust_score: 70 }, { onConflict: "phone" });

  const { data: vendor, error: vErr } = await admin
    .from("vendors")
    .insert({
      name: `AFG Vendor ${T}`,
      shop_name: `!AFG-${T}`,
      phone: vendorPhone,
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
  if (vErr || !vendor) throw new Error(`seed vendor: ${vErr?.message}`);
  created.vendorId = vendor.id;

  // --- Accept forgery: cancelled + fake p_from_status ---
  const cancelledId = await seedRequest("cancelled");
  const forgeCancelled = await anon.rpc("vendor_accept_order", {
    p_request_id: cancelledId,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "cancelled",
  });
  check("accept_reject_forged_cancelled", !!forgeCancelled.error && /invalid_from_status/i.test(errMsg(forgeCancelled.error) ?? ""), {
    rpc: "vendor_accept_order",
    error: errMsg(forgeCancelled.error),
    status: await statusOf(cancelledId),
  });

  const forgeExpired = await seedRequest("expired");
  const forgeExpiredRpc = await anon.rpc("vendor_accept_order", {
    p_request_id: forgeExpired,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "expired",
  });
  check("accept_reject_forged_expired", !!forgeExpiredRpc.error && /invalid_from_status/i.test(errMsg(forgeExpiredRpc.error) ?? ""), {
    rpc: "vendor_accept_order",
    error: errMsg(forgeExpiredRpc.error),
    status: await statusOf(forgeExpired),
  });

  const doneId = await seedRequest("done");
  const forgeDone = await anon.rpc("vendor_accept_order", {
    p_request_id: doneId,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "done",
  });
  check("accept_reject_forged_done", !!forgeDone.error && /invalid_from_status/i.test(errMsg(forgeDone.error) ?? ""), {
    rpc: "vendor_accept_order",
    error: errMsg(forgeDone.error),
    status: await statusOf(doneId),
  });

  // Terminal row + legitimate-looking p_from_status still must not resurrect
  const cancelled2 = await seedRequest("cancelled");
  const mismatch = await anon.rpc("vendor_accept_order", {
    p_request_id: cancelled2,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "sent",
  });
  check("accept_reject_cancelled_with_sent_claim", !mismatch.error && mismatch.data === false && (await statusOf(cancelled2)) === "cancelled", {
    rpc: "vendor_accept_order",
    error: errMsg(mismatch.error),
    data: mismatch.data,
    status: await statusOf(cancelled2),
  });

  // --- Fulfil from wrong status (live RPC: vendor_fulfil_order) ---
  const sentId = await seedRequest("sent");
  const fulfilSent = await anon.rpc("vendor_fulfil_order", {
    p_request_id: sentId,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
  });
  check("fulfil_reject_sent", !!fulfilSent.error && /not_accepted/i.test(errMsg(fulfilSent.error) ?? ""), {
    rpc: "vendor_fulfil_order",
    error: errMsg(fulfilSent.error),
    status: await statusOf(sentId),
  });

  const cancelFulfilId = await seedRequest("cancelled");
  const fulfilCancel = await anon.rpc("vendor_fulfil_order", {
    p_request_id: cancelFulfilId,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
  });
  check("fulfil_reject_cancelled", !!fulfilCancel.error && /not_accepted/i.test(errMsg(fulfilCancel.error) ?? ""), {
    rpc: "vendor_fulfil_order",
    error: errMsg(fulfilCancel.error),
    status: await statusOf(cancelFulfilId),
  });

  // Mistaken twin must be gone
  const settleGone = await anon.rpc("vendor_settle_order", {
    p_request_id: sentId,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
  });
  check("settle_rpc_dropped", !!settleGone.error && /could not find|does not exist|PGRST202/i.test(errMsg(settleGone.error) ?? ""), {
    rpc: "vendor_settle_order",
    error: errMsg(settleGone.error),
  });

  // --- Legitimate sent → accepted ---
  const legitSent = await seedRequest("sent");
  const acceptOk = await anon.rpc("vendor_accept_order", {
    p_request_id: legitSent,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "sent",
  });
  check("accept_sent_ok", !acceptOk.error && acceptOk.data === true && (await statusOf(legitSent)) === "accepted", {
    rpc: "vendor_accept_order",
    error: errMsg(acceptOk.error),
    data: acceptOk.data,
    status: await statusOf(legitSent),
  });

  // Bill required by fulfil trigger (cannot_fulfil_without_bill)
  const { error: billErr } = await admin.from("order_bills").insert({
    request_id: legitSent,
    vendor_id: created.vendorId,
    user_phone: custPhone,
    total_amount: 50,
    payment_mode: "cash",
    payment_status: "unpaid",
  });
  if (billErr) throw new Error(`seed bill: ${billErr.message}`);

  // --- Legitimate accepted → fulfilled via vendor_fulfil_order ---
  const fulfilOk = await anon.rpc("vendor_fulfil_order", {
    p_request_id: legitSent,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
  });
  check("fulfil_accepted_ok", !fulfilOk.error && (await statusOf(legitSent)) === "fulfilled", {
    rpc: "vendor_fulfil_order",
    error: errMsg(fulfilOk.error),
    status: await statusOf(legitSent),
  });

  // seen → accepted also legit
  const legitSeen = await seedRequest("seen");
  const acceptSeen = await anon.rpc("vendor_accept_order", {
    p_request_id: legitSeen,
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_from_status: "seen",
  });
  check("accept_seen_ok", !acceptSeen.error && acceptSeen.data === true && (await statusOf(legitSeen)) === "accepted", {
    rpc: "vendor_accept_order",
    error: errMsg(acceptSeen.error),
    data: acceptSeen.data,
    status: await statusOf(legitSeen),
  });
} catch (e) {
  failed = true;
  results.fatal = String(e?.message ?? e);
  console.error("FATAL", e);
} finally {
  await cleanup();
  console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
