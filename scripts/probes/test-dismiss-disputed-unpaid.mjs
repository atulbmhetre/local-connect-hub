/**
 * TEST/PROD: disputed unpaid bills can be dismissed; dispute record unchanged.
 * Also confirms admin_resolve_disputed_upi_payment is gone.
 * Usage:
 *   node scripts/probes/test-dismiss-disputed-unpaid.mjs
 *   node scripts/probes/test-dismiss-disputed-unpaid.mjs --prod
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

console.log(`=== ${isProd ? "PROD" : "TEST"} dismiss disputed unpaid ===`);
console.log("project_ref:", ref);
if (ref !== expectedRef || !anonKey || !service) {
  console.error("HARD STOP");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });
const T = Date.now();
const vendorPhone = `9836${String(T).slice(-6)}`;
const custPhone = `8846${String(T).slice(-6)}`;
const deviceId = `disdismiss_${T}`;

const created = { vendorId: null, requestIds: [], billIds: [] };
const results = {};
let failed = false;

function check(name, ok, detail) {
  results[name] = { ok, ...detail };
  if (!ok) failed = true;
  console.log(ok ? `PASS ${name}` : `FAIL ${name}`, detail);
}

async function cleanup() {
  if (created.billIds.length) {
    await admin.from("order_bills").delete().in("id", created.billIds);
  }
  if (created.requestIds.length) {
    await admin.from("payment_dispute_events").delete().in("request_id", created.requestIds);
    await admin.from("order_bills").delete().in("request_id", created.requestIds);
    await admin.from("requests").delete().in("id", created.requestIds);
  }
  if (created.vendorId) {
    await admin.from("vendor_categories").delete().eq("vendor_id", created.vendorId);
    await admin.from("vendors").delete().eq("id", created.vendorId);
  }
  await admin.from("users").delete().eq("phone", custPhone);
}

try {
  await admin.from("users").upsert({ phone: custPhone, trust_score: 70 }, { onConflict: "phone" });

  const { data: vendor, error: vErr } = await admin
    .from("vendors")
    .insert({
      name: `DisDismiss ${T}`,
      shop_name: `!DISDISMISS-${T}`,
      phone: vendorPhone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
    })
    .select("id")
    .single();
  if (vErr || !vendor) throw new Error(vErr?.message);
  created.vendorId = vendor.id;

  async function seedDisputed(status = "fulfilled") {
    const { data: req, error } = await admin
      .from("requests")
      .insert({
        vendor_id: created.vendorId,
        user_phone: custPhone,
        device_id: deviceId,
        message: `disdismiss-${T}`,
        status,
        service_mode: "delivery",
        payment_status: "disputed",
      })
      .select("id, payment_status, status")
      .single();
    if (error || !req) throw new Error(error?.message);
    created.requestIds.push(req.id);

    const { data: bill, error: bErr } = await admin
      .from("order_bills")
      .insert({
        request_id: req.id,
        vendor_id: created.vendorId,
        user_phone: custPhone,
        total_amount: 99,
        payment_mode: "upi",
        payment_status: "unpaid",
      })
      .select("id, payment_status")
      .single();
    if (bErr || !bill) throw new Error(bErr?.message);
    created.billIds.push(bill.id);
    return { req, bill };
  }

  // Control: unpaid non-disputed still blocked for customer
  const { data: ctrlReq } = await admin
    .from("requests")
    .insert({
      vendor_id: created.vendorId,
      user_phone: custPhone,
      device_id: `${deviceId}_ctrl`,
      message: "control unpaid",
      status: "fulfilled",
      service_mode: "delivery",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  created.requestIds.push(ctrlReq.id);
  const { data: ctrlBill } = await admin
    .from("order_bills")
    .insert({
      request_id: ctrlReq.id,
      vendor_id: created.vendorId,
      user_phone: custPhone,
      total_amount: 10,
      payment_mode: "upi",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  created.billIds.push(ctrlBill.id);

  const ctrlDismiss = await anon.rpc("dismiss_order", {
    p_request_id: ctrlReq.id,
    p_device_id: `${deviceId}_ctrl`,
    p_user_phone: custPhone,
  });
  check("unpaid_non_disputed_still_blocked", !!ctrlDismiss.error && /dismiss_blocked_unpaid_bill/i.test(ctrlDismiss.error.message), {
    rpc: "dismiss_order",
    error: ctrlDismiss.error?.message ?? null,
  });

  // Customer dismiss disputed+unpaid
  const cust = await seedDisputed("fulfilled");
  const custDismiss = await anon.rpc("dismiss_order", {
    p_request_id: cust.req.id,
    p_device_id: deviceId,
    p_user_phone: custPhone,
  });
  const { data: custAfter } = await admin
    .from("requests")
    .select("status, payment_status")
    .eq("id", cust.req.id)
    .single();
  const { data: custBillAfter } = await admin
    .from("order_bills")
    .select("payment_status")
    .eq("id", cust.bill.id)
    .single();
  check(
    "customer_dismiss_disputed_unpaid",
    !custDismiss.error &&
      custAfter?.status === "done" &&
      custAfter?.payment_status === "disputed" &&
      custBillAfter?.payment_status === "unpaid",
    {
      rpc: "dismiss_order",
      error: custDismiss.error?.message ?? null,
      status: custAfter?.status,
      payment_status: custAfter?.payment_status,
      bill_status: custBillAfter?.payment_status,
    },
  );

  // Vendor dismiss disputed+unpaid
  const vend = await seedDisputed("fulfilled");
  const vendDismiss = await anon.rpc("vendor_dismiss_requests", {
    p_vendor_id: created.vendorId,
    p_vendor_phone: vendorPhone,
    p_request_ids: [vend.req.id],
  });
  const { data: vendAfter } = await admin
    .from("requests")
    .select("status, payment_status")
    .eq("id", vend.req.id)
    .single();
  const { data: vendBillAfter } = await admin
    .from("order_bills")
    .select("payment_status")
    .eq("id", vend.bill.id)
    .single();
  check(
    "vendor_dismiss_disputed_unpaid",
    !vendDismiss.error &&
      vendAfter?.status === "done" &&
      vendAfter?.payment_status === "disputed" &&
      vendBillAfter?.payment_status === "unpaid",
    {
      rpc: "vendor_dismiss_requests",
      error: vendDismiss.error?.message ?? null,
      status: vendAfter?.status,
      payment_status: vendAfter?.payment_status,
      bill_status: vendBillAfter?.payment_status,
    },
  );

  // Admin resolve must be gone
  const gone = await anon.rpc("admin_resolve_disputed_upi_payment", {
    p_request_id: vend.req.id,
    p_resolution: "void",
    p_notes: "should not exist",
  });
  check(
    "admin_resolve_dropped",
    !!gone.error && /could not find|does not exist|PGRST202|permission denied/i.test(gone.error.message),
    {
      rpc: "admin_resolve_disputed_upi_payment",
      error: gone.error?.message ?? null,
    },
  );
} catch (e) {
  failed = true;
  results.fatal = String(e?.message ?? e);
  console.error("FATAL", e);
} finally {
  await cleanup();
  console.log(JSON.stringify(results, null, 2));
  process.exit(failed ? 1 : 0);
}
