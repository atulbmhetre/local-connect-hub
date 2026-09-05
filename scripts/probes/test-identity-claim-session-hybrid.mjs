/**
 * Soft hybrid probe for the seven identity-claiming RPCs.
 * Exact list:
 *   register_vendor, ensure_user_device_link, upsert_app_user,
 *   get_vendor_by_phone_login, migrate_saved_vendors_phone,
 *   migrate_device_requests_phone, apply_user_referral
 *
 * For EACH RPC, three states:
 *   D1 — Auth session phone A, claim phone B → must reject (not_found_or_unauthorized)
 *   D2 — Auth session phone A, claim phone A → must succeed (or domain-ok non-auth error)
 *   D3 — no Auth session (OTP-off), claim phone B → must behave as today (not session-reject)
 *
 * Usage:
 *   node scripts/probes/test-identity-claim-session-hybrid.mjs --env=test
 *   node scripts/probes/test-identity-claim-session-hybrid.mjs --env=prod
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const ENVS = {
  test: { ref: "hhdylnhqdzfabsolwxdz", envFile: ".env.test", label: "TEST" },
  prod: { ref: "rpxsyeqskvhjmbkxnpmd", envFile: ".env.test.prod", label: "PROD" },
};

const envArg = (process.argv.find((a) => a.startsWith("--env=")) ?? "").slice("--env=".length);
if (!ENVS[envArg]) {
  console.error("Usage: node scripts/probes/test-identity-claim-session-hybrid.mjs --env=test|prod");
  process.exit(1);
}
const ENV = ENVS[envArg];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ENV.envFile), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const anon = (process.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(ENV.ref) || !anon || !service) {
  console.error(`HARD STOP: ${ENV.envFile} is not ${ENV.label} or missing keys`);
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const T = Date.now();
const phoneA = `98406${String(T).slice(-5)}`;
const phoneB = `98417${String((T + 11111) % 100000).padStart(5, "0")}`;
const phoneC = `98428${String((T + 22222) % 100000).padStart(5, "0")}`;
const emailA = `test+91${phoneA}@aaspaas.invalid`;
const passwordA = `test_pw_${phoneA}`;
const deviceA = `idclaim-a-${T}`;
const deviceB = `idclaim-b-${T}`;
const deviceOff = `idclaim-off-${T}`;

const results = {};
const cleanup = {
  authUserId: null,
  vendorIds: [],
  categoryId: null,
  referrerVendorId: null,
  referralCode: null,
};

function runLinkedSql(sql, label) {
  const refFile = path.join(root, "supabase", ".temp", "project-ref");
  const linked = fs.existsSync(refFile) ? fs.readFileSync(refFile, "utf8").trim() : "";
  if (linked !== ENV.ref) {
    throw new Error(
      `CLI linked to ${linked || "(none)"}, expected ${ENV.ref}. Re-link before SQL helper.`,
    );
  }
  const secret =
    process.env.SEND_SMS_HOOK_SECRET &&
    /^v1,whsec_.{32,}$/.test(process.env.SEND_SMS_HOOK_SECRET)
      ? process.env.SEND_SMS_HOOK_SECRET
      : "v1,whsec_" + Buffer.from("local-cli-config-placeholder-32").toString("base64");
  const sqlPath = path.join(os.tmpdir(), `idclaim-${label}-${Date.now()}.sql`);
  fs.writeFileSync(sqlPath, sql, "utf8");
  const r = spawnSync(
    "npx",
    ["supabase", "db", "query", "--linked", "-f", sqlPath],
    {
      cwd: root,
      encoding: "utf8",
      shell: true,
      env: { ...process.env, SEND_SMS_HOOK_SECRET: secret },
    },
  );
  if (r.status !== 0) {
    throw new Error(`SQL ${label} failed: ${r.stderr || r.stdout}`);
  }
}

function msg(err) {
  return err?.message ?? null;
}

function isUnauthorized(err) {
  return String(msg(err) ?? "").includes("not_found_or_unauthorized");
}

function record(rpc, state, pass, detail) {
  if (!results[rpc]) results[rpc] = {};
  results[rpc][state] = { pass, detail };
  const mark = pass ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${rpc} ${state}: ${detail}`);
}

async function clientWithSession() {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({
    email: emailA,
    password: passwordA,
  });
  if (error) throw new Error(`signIn A: ${error.message}`);
  return c;
}

function anonClient() {
  return createClient(url, anon, { auth: { persistSession: false } });
}

async function loadCategory() {
  const { data, error } = await admin
    .from("categories")
    .select("id, label, service_mode")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error(`category: ${error?.message ?? "none"}`);
  cleanup.categoryId = data.id;
  return data;
}

function registerArgs(phone, cat) {
  const mode = String(cat.service_mode ?? "help").toLowerCase();
  return {
    p_name: `IdClaim ${phone}`,
    p_shop_name: `!IDCLAIM-${phone}-${T}`,
    p_category: cat.label,
    p_phone: phone,
    p_upi_id: `idclaim${phone}@upi`,
    p_service_mode: mode,
    p_vendor_type: "shop",
    p_vendor_note: `idclaim:${T}`,
    p_latitude: 18.5204,
    p_longitude: 73.8567,
    p_referral_code: `AASP${phone.slice(-4)}`,
    p_profile_status: "complete",
    p_category_ids: [cat.id],
    p_category_service_modes: [mode],
    p_category_modes: { [cat.id]: [mode] },
    p_base_type: "shop",
    p_serves_at_vendor_place: true,
    p_serves_at_customer_place: false,
    p_service_radius_km: 5,
    p_availability_modes: [mode],
  };
}

async function seedVendorForLogin(phone) {
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `IdClaim Login ${phone}`,
      shop_name: `!IDCLAIM-LOGIN-${phone}-${T}`,
      phone,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
      is_banned: false,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed login vendor: ${error?.message}`);
  cleanup.vendorIds.push(data.id);
  return data.id;
}

async function seedReferrer() {
  const code = `IDCL${String(T).slice(-4)}`;
  const { data, error } = await admin
    .from("vendors")
    .insert({
      name: `IdClaim Referrer ${T}`,
      shop_name: `!IDCLAIM-REF-${T}`,
      phone: `98509${String((T + 33333) % 100000).padStart(5, "0")}`,
      category: "Test",
      service_mode: "delivery",
      is_active: true,
      profile_status: "complete",
      latitude: 18.52,
      longitude: 73.85,
      service_radius_km: 5,
      referral_code: code,
    })
    .select("id, referral_code, phone")
    .single();
  if (error || !data) throw new Error(`seed referrer: ${error?.message}`);
  cleanup.referrerVendorId = data.id;
  cleanup.referralCode = data.referral_code;
  cleanup.vendorIds.push(data.id);
  return data;
}

try {
  console.log(`=== Identity-claim soft hybrid probe (${ENV.label} ${ENV.ref}) ===`);
  console.log("phones A/B/C:", phoneA, phoneB, phoneC);

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: emailA,
    phone: `+91${phoneA}`,
    email_confirm: true,
    phone_confirm: true,
    password: passwordA,
  });
  if (createErr && !/already|exists|registered/i.test(createErr.message)) {
    throw new Error(`createUser A: ${createErr.message}`);
  }
  cleanup.authUserId = created?.user?.id ?? null;

  const cat = await loadCategory();
  await seedVendorForLogin(phoneA);
  await seedVendorForLogin(phoneB);
  await seedReferrer();

  await admin.from("saved_vendors").insert({
    device_id: deviceA,
    vendor_id: cleanup.vendorIds[0],
    user_phone: null,
  });
  await admin.from("requests").insert({
    vendor_id: cleanup.vendorIds[0],
    device_id: deviceA,
    user_phone: null,
    message: "idclaim migrate seed",
    status: "pending",
    service_mode: "delivery",
  });
  await admin.from("saved_vendors").insert({
    device_id: deviceOff,
    vendor_id: cleanup.vendorIds[0],
    user_phone: null,
  });
  await admin.from("requests").insert({
    vendor_id: cleanup.vendorIds[0],
    device_id: deviceOff,
    user_phone: null,
    message: "idclaim migrate off",
    status: "pending",
    service_mode: "delivery",
  });

  const session = await clientWithSession();
  const off = anonClient();

  {
    const rpc = "ensure_user_device_link";
    const d1 = await session.rpc(rpc, { p_user_phone: phoneB, p_device_id: deviceB });
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, { p_user_phone: phoneA, p_device_id: deviceA });
    record(rpc, "D2_match", !d2.error, msg(d2.error) ?? "ok");
    const d3 = await off.rpc(rpc, { p_user_phone: phoneB, p_device_id: deviceOff });
    record(rpc, "D3_otp_off", !d3.error && !isUnauthorized(d3.error), msg(d3.error) ?? "ok");
  }

  {
    const rpc = "upsert_app_user";
    const d1 = await session.rpc(rpc, { p_phone: phoneB, p_lang: "en" });
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, { p_phone: phoneA, p_lang: "en" });
    record(rpc, "D2_match", !d2.error, msg(d2.error) ?? "ok");
    const d3 = await off.rpc(rpc, { p_phone: phoneB, p_lang: "en" });
    record(rpc, "D3_otp_off", !d3.error && !isUnauthorized(d3.error), msg(d3.error) ?? "ok");
  }

  {
    const rpc = "get_vendor_by_phone_login";
    const d1 = await session.rpc(rpc, { p_phone: phoneB, p_device_id: deviceB });
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, { p_phone: phoneA, p_device_id: deviceA });
    const d2ok = !d2.error && d2.data?.phone === phoneA;
    record(rpc, "D2_match", d2ok, msg(d2.error) ?? `phone=${d2.data?.phone ?? "null"}`);
    const d3 = await off.rpc(rpc, { p_phone: phoneB, p_device_id: `${deviceOff}-login` });
    const d3ok = !d3.error && !isUnauthorized(d3.error) && d3.data?.phone === phoneB;
    record(rpc, "D3_otp_off", d3ok, msg(d3.error) ?? `phone=${d3.data?.phone ?? "null"}`);
  }

  {
    const rpc = "migrate_saved_vendors_phone";
    const d1 = await session.rpc(rpc, { p_device_id: deviceA, p_user_phone: phoneB });
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, { p_device_id: deviceA, p_user_phone: phoneA });
    record(rpc, "D2_match", !d2.error, msg(d2.error) ?? "ok");
    const d3 = await off.rpc(rpc, { p_device_id: deviceOff, p_user_phone: phoneB });
    record(rpc, "D3_otp_off", !d3.error && !isUnauthorized(d3.error), msg(d3.error) ?? "ok");
  }

  {
    const rpc = "migrate_device_requests_phone";
    const d1 = await session.rpc(rpc, { p_device_id: deviceA, p_user_phone: phoneB });
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, { p_device_id: deviceA, p_user_phone: phoneA });
    record(rpc, "D2_match", !d2.error, msg(d2.error) ?? "ok");
    const d3 = await off.rpc(rpc, { p_device_id: deviceOff, p_user_phone: phoneB });
    record(rpc, "D3_otp_off", !d3.error && !isUnauthorized(d3.error), msg(d3.error) ?? "ok");
  }

  {
    const rpc = "apply_user_referral";
    const code = cleanup.referralCode;
    runLinkedSql(
      "ALTER TABLE public.vendor_credits DISABLE TRIGGER trg_notify_vendor_on_referral_credit;",
      "disable-ref-notify",
    );
    try {
      const d1 = await session.rpc(rpc, {
        p_phone: phoneB,
        p_device_id: deviceB,
        p_referral_code: code,
      });
      const d1raised = isUnauthorized(d1.error);
      let d1applied = false;
      if (!d1.error && d1.data && typeof d1.data === "object") {
        d1applied = d1.data.applied === true;
      }
      record(
        rpc,
        "D1_mismatch",
        d1raised && !d1applied,
        d1raised ? msg(d1.error) : JSON.stringify(d1.data),
      );

      const d2 = await session.rpc(rpc, {
        p_phone: phoneA,
        p_device_id: deviceA,
        p_referral_code: code,
      });
      const d2ok =
        !isUnauthorized(d2.error) &&
        d2.error == null &&
        d2.data &&
        typeof d2.data === "object" &&
        (d2.data.applied === true || typeof d2.data.reason === "string");
      record(rpc, "D2_match", d2ok, msg(d2.error) ?? JSON.stringify(d2.data));

      const d3 = await off.rpc(rpc, {
        p_phone: phoneC,
        p_device_id: `${deviceOff}-ref`,
        p_referral_code: code,
      });
      const d3ok =
        !isUnauthorized(d3.error) &&
        !d3.error &&
        d3.data &&
        typeof d3.data === "object" &&
        (d3.data.applied === true || typeof d3.data.reason === "string");
      record(rpc, "D3_otp_off", d3ok, msg(d3.error) ?? JSON.stringify(d3.data));
    } finally {
      runLinkedSql(
        "ALTER TABLE public.vendor_credits ENABLE TRIGGER trg_notify_vendor_on_referral_credit;",
        "enable-ref-notify",
      );
    }
  }

  {
    const rpc = "register_vendor";
    const d1 = await session.rpc(rpc, registerArgs(phoneB, cat));
    record(rpc, "D1_mismatch", isUnauthorized(d1.error), msg(d1.error) ?? "no error");
    const d2 = await session.rpc(rpc, registerArgs(phoneA, cat));
    const d2ok =
      !isUnauthorized(d2.error) &&
      (typeof d2.data === "string" ||
        /duplicate|unique|23505/i.test(String(msg(d2.error) ?? "")));
    if (typeof d2.data === "string") cleanup.vendorIds.push(d2.data);
    record(rpc, "D2_match", d2ok, msg(d2.error) ?? `id=${d2.data}`);
    const d3 = await off.rpc(rpc, registerArgs(phoneC, cat));
    const d3ok = !isUnauthorized(d3.error) && typeof d3.data === "string";
    if (typeof d3.data === "string") cleanup.vendorIds.push(d3.data);
    record(rpc, "D3_otp_off", d3ok, msg(d3.error) ?? `id=${d3.data}`);
  }

  console.log("\n=== SUMMARY ===");
  let failed = 0;
  for (const [rpc, states] of Object.entries(results)) {
    for (const [state, row] of Object.entries(states)) {
      if (!row.pass) failed += 1;
      console.log(`${rpc}\t${state}\t${row.pass ? "PASS" : "FAIL"}\t${row.detail}`);
    }
  }
  console.log(failed === 0 ? "\nALL PASSED" : `\nFAILED cells: ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error("PROBE FATAL:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  try {
    for (const id of cleanup.vendorIds) {
      await admin.from("vendor_credits").delete().eq("vendor_id", id);
      await admin.from("referrals").delete().eq("referrer_vendor_id", id);
      await admin.from("vendor_categories").delete().eq("vendor_id", id);
      await admin.from("saved_vendors").delete().eq("vendor_id", id);
      await admin.from("requests").delete().eq("vendor_id", id);
      await admin.from("vendors").delete().eq("id", id);
    }
    await admin
      .from("user_devices")
      .delete()
      .in("device_id", [deviceA, deviceB, deviceOff, `${deviceOff}-login`, `${deviceOff}-ref`]);
    await admin.from("users").delete().in("phone", [phoneA, phoneB, phoneC]);
    await admin.from("app_users").delete().in("phone", [phoneA, phoneB, phoneC]);
    await admin.from("referrals").delete().eq("referee_id", phoneA);
    await admin.from("referrals").delete().eq("referee_id", phoneC);
    if (cleanup.authUserId) {
      await admin.auth.admin.deleteUser(cleanup.authUserId);
    } else {
      const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const u = (listed?.users ?? []).find((x) => x.email === emailA);
      if (u) await admin.auth.admin.deleteUser(u.id);
    }
  } catch (cleanupErr) {
    console.warn("cleanup warning:", cleanupErr?.message ?? cleanupErr);
  }
}
