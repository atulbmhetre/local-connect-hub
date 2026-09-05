/**
 * TEST/PROD: High-severity state-machine gaps (1–4).
 * Usage:
 *   node scripts/probes/test-state-machine-high-gaps.mjs
 *   node scripts/probes/test-state-machine-high-gaps.mjs --prod
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

console.log(`=== ${isProd ? "PROD" : "TEST"} state-machine high gaps ===`);
console.log("project_ref:", ref);

if (ref !== expectedRef || !anonKey || !service) {
  console.error("HARD STOP: wrong env or missing keys");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

const T = Date.now();
const vendorPhone = `9832${String(T).slice(-6)}`;
const custPhone = `8842${String(T).slice(-6)}`;
const adminEmail = `smhg-admin-${T}@aaspaas.invalid`;
const adminPassword = `SmHg_${T}_pw!`;

const created = {
  vendorIds: [],
  requestIds: [],
  billIds: [],
  recurringIds: [],
  adminUserId: null,
  phones: [vendorPhone, custPhone],
};

const results = {};
let failed = false;

function errMsg(e) {
  return e?.message ?? null;
}

function check(name, ok, detail) {
  results[name] = { ok, ...detail };
  if (!ok) failed = true;
  console.log(ok ? `PASS ${name}` : `FAIL ${name}`, detail);
}

async function cleanup() {
  if (created.billIds.length) {
    await admin.from("order_items").delete().in("bill_id", created.billIds);
    await admin.from("order_bills").delete().in("id", created.billIds);
  }
  if (created.requestIds.length) {
    await admin.from("order_bills").delete().in("request_id", created.requestIds);
    await admin.from("payment_dispute_events").delete().in("request_id", created.requestIds);
    await admin.from("requests").delete().in("id", created.requestIds);
  }
  if (created.recurringIds.length) {
    await admin.from("recurring_orders").delete().in("id", created.recurringIds);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from("vendor_categories").delete().eq("vendor_id", vendorId);
    await admin.from("vendors").delete().eq("id", vendorId);
  }
  for (const phone of created.phones) {
    await admin.from("users").delete().eq("phone", phone);
  }
  if (created.adminUserId) {
    await admin.from("admin_users").delete().eq("user_id", created.adminUserId);
    await admin.auth.admin.deleteUser(created.adminUserId);
  }
}

async function seedVendor(phone, mode = "delivery", extras = {}) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `SMHG ${mode} ${T}`,
      shop_name: `!SMHG-${mode}-${T}`,
      phone,
      category: "Test",
      service_mode: mode,
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
      ...extras,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed vendor: ${error?.message}`);
  created.vendorIds.push(data.id);
  return data.id;
}

async function seedRequest(vendorId, status, extras = {}) {
  const { data, error } = await admin
    .from("requests")
    .insert({
      vendor_id: vendorId,
      user_phone: custPhone,
      device_id: `smhg_${T}`,
      message: `smhg-${status}-${T}`,
      status,
      service_mode: extras.service_mode ?? "delivery",
      ...extras,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed request: ${error?.message}`);
  created.requestIds.push(data.id);
  return data.id;
}

async function statusOf(id) {
  const { data } = await admin.from("requests").select("status, payment_status").eq("id", id).single();
  return data;
}

try {
  await admin.from("users").upsert({ phone: custPhone, trust_score: 70 }, { onConflict: "phone" });

  // ── 1) Help seen expires ──
  const helpVendorId = await seedVendor(`9833${String(T).slice(-6)}`, "help");
  created.phones.push(`9833${String(T).slice(-6)}`);
  const helpSeenId = await seedRequest(helpVendorId, "seen", { service_mode: "help" });
  const twentyMinAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  await admin.from("requests").update({ created_at: twentyMinAgo }).eq("id", helpSeenId);
  const { error: expErr } = await admin.rpc("expire_pending_orders");
  const helpAfter = await statusOf(helpSeenId);
  check("help_seen_expires", !expErr && helpAfter?.status === "expired", {
    rpc: "expire_pending_orders",
    error: errMsg(expErr),
    status: helpAfter?.status,
  });

  // ── 3) vendor_cancel from-state gate ──
  const cancelVendorId = await seedVendor(vendorPhone, "delivery");
  const fulfilledId = await seedRequest(cancelVendorId, "fulfilled");
  const cancelFulfil = await anon.rpc("vendor_cancel_order", {
    p_request_id: fulfilledId,
    p_vendor_id: cancelVendorId,
    p_vendor_phone: vendorPhone,
    p_cancel_reason: "probe",
    p_cancel_appointment: false,
  });
  check("cancel_reject_fulfilled", !!cancelFulfil.error && /invalid_from_status/i.test(errMsg(cancelFulfil.error) ?? ""), {
    rpc: "vendor_cancel_order",
    error: errMsg(cancelFulfil.error),
    status: (await statusOf(fulfilledId))?.status,
  });

  const doneId = await seedRequest(cancelVendorId, "done");
  const cancelDone = await anon.rpc("vendor_cancel_order", {
    p_request_id: doneId,
    p_vendor_id: cancelVendorId,
    p_vendor_phone: vendorPhone,
    p_cancel_reason: "probe",
  });
  check("cancel_reject_done", !!cancelDone.error && /invalid_from_status/i.test(errMsg(cancelDone.error) ?? ""), {
    rpc: "vendor_cancel_order",
    error: errMsg(cancelDone.error),
    status: (await statusOf(doneId))?.status,
  });

  const acceptedId = await seedRequest(cancelVendorId, "accepted");
  const cancelAccepted = await anon.rpc("vendor_cancel_order", {
    p_request_id: acceptedId,
    p_vendor_id: cancelVendorId,
    p_vendor_phone: vendorPhone,
    p_cancel_reason: "probe-ok",
  });
  check("cancel_accepted_ok", !cancelAccepted.error && (await statusOf(acceptedId))?.status === "cancelled", {
    rpc: "vendor_cancel_order",
    error: errMsg(cancelAccepted.error),
    status: (await statusOf(acceptedId))?.status,
  });

  // ── 2) Admin resolve disputed UPI ──
  const { data: adminUser, error: adminCreateErr } = await admin.auth.admin.createUser({
    email: adminEmail,
    email_confirm: true,
    password: adminPassword,
  });
  if (adminCreateErr || !adminUser?.user?.id) {
    throw new Error(`admin createUser: ${adminCreateErr?.message}`);
  }
  created.adminUserId = adminUser.user.id;
  const { error: allowErr } = await admin.from("admin_users").insert({ user_id: created.adminUserId });
  if (allowErr) throw new Error(`admin_users: ${allowErr.message}`);

  const asAdmin = createClient(url, anonKey, { auth: { persistSession: false } });
  const { error: signErr } = await asAdmin.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });
  if (signErr) throw new Error(`admin signIn: ${signErr.message}`);

  const disputeConfirmId = await seedRequest(cancelVendorId, "fulfilled", {
    payment_status: "disputed",
    service_mode: "delivery",
  });
  const { data: bill1, error: bill1Err } = await admin
    .from("order_bills")
    .insert({
      request_id: disputeConfirmId,
      vendor_id: cancelVendorId,
      user_phone: custPhone,
      total_amount: 40,
      payment_mode: "upi",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (bill1Err || !bill1) throw new Error(`bill1: ${bill1Err?.message}`);
  created.billIds.push(bill1.id);

  const resolveConfirm = await asAdmin.rpc("admin_resolve_disputed_upi_payment", {
    p_request_id: disputeConfirmId,
    p_resolution: "confirmed",
    p_notes: "probe dispute invalid",
  });
  const afterConfirm = await statusOf(disputeConfirmId);
  const { data: bill1After } = await admin.from("order_bills").select("payment_status").eq("id", bill1.id).single();
  check("admin_resolve_confirmed", !resolveConfirm.error && afterConfirm?.payment_status === "confirmed" && bill1After?.payment_status === "paid", {
    rpc: "admin_resolve_disputed_upi_payment",
    error: errMsg(resolveConfirm.error),
    payment_status: afterConfirm?.payment_status,
    bill_status: bill1After?.payment_status,
  });

  const disputeVoidId = await seedRequest(cancelVendorId, "fulfilled", {
    payment_status: "disputed",
  });
  const { data: bill2, error: bill2Err } = await admin
    .from("order_bills")
    .insert({
      request_id: disputeVoidId,
      vendor_id: cancelVendorId,
      user_phone: custPhone,
      total_amount: 55,
      payment_mode: "upi",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (bill2Err || !bill2) throw new Error(`bill2: ${bill2Err?.message}`);
  created.billIds.push(bill2.id);

  const resolveVoid = await asAdmin.rpc("admin_resolve_disputed_upi_payment", {
    p_request_id: disputeVoidId,
    p_resolution: "void",
    p_notes: "probe vendor concedes",
  });
  const afterVoid = await statusOf(disputeVoidId);
  const { data: bill2After } = await admin.from("order_bills").select("payment_status").eq("id", bill2.id).single();
  check("admin_resolve_void", !resolveVoid.error && afterVoid?.payment_status === "void" && bill2After?.payment_status === "void", {
    rpc: "admin_resolve_disputed_upi_payment",
    error: errMsg(resolveVoid.error),
    payment_status: afterVoid?.payment_status,
    bill_status: bill2After?.payment_status,
  });

  const nonAdmin = await anon.rpc("admin_resolve_disputed_upi_payment", {
    p_request_id: disputeVoidId,
    p_resolution: "void",
    p_notes: "should fail",
  });
  check(
    "admin_resolve_rejects_non_admin",
    !!nonAdmin.error &&
      /(unauthorized|permission denied)/i.test(errMsg(nonAdmin.error) ?? ""),
    {
      rpc: "admin_resolve_disputed_upi_payment",
      error: errMsg(nonAdmin.error),
    },
  );

  // ── 4) Recurring pause on vendor banned ──
  const recVendorPhone = `9834${String(T).slice(-6)}`;
  created.phones.push(recVendorPhone);
  const recVendorId = await seedVendor(recVendorPhone, "delivery");
  const { data: cat } = await admin.from("categories").select("id").eq("is_active", true).limit(1).single();
  const nextRunPast = new Date(Date.now() - 60_000).toISOString();
  const { data: rec, error: recErr } = await admin
    .from("recurring_orders")
    .insert({
      vendor_id: recVendorId,
      user_phone: custPhone,
      device_id: `smhg_rec_${T}`,
      category_id: cat?.id ?? null,
      service_mode: "delivery",
      interval_kind: "daily",
      interval_days: 1,
      status: "active",
      message: "smhg recurring",
      delivery_address: "SMHG addr",
      delivery_slot: "evening",
      next_run_at: nextRunPast,
      items: [{ name: "milk", qty: 1 }],
    })
    .select("id, next_run_at, status")
    .single();
  if (recErr || !rec) throw new Error(`recurring: ${recErr?.message}`);
  created.recurringIds.push(rec.id);

  await admin.from("vendors").update({ is_banned: true, ban_reason: "smhg probe" }).eq("id", recVendorId);
  const { data: spawned, error: spawnErr } = await admin.rpc("spawn_due_recurring_orders");
  const { data: recAfter } = await admin
    .from("recurring_orders")
    .select("status, next_run_at")
    .eq("id", rec.id)
    .single();
  check("recurring_pauses_on_vendor_banned", !spawnErr && recAfter?.status === "paused" && recAfter?.next_run_at === rec.next_run_at, {
    rpc: "spawn_due_recurring_orders",
    error: errMsg(spawnErr),
    spawned,
    status: recAfter?.status,
    next_run_unchanged: recAfter?.next_run_at === rec.next_run_at,
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
