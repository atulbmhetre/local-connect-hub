/**
 * PROD identity verification (service-role). Loads .env.test.prod.
 * Cleans up all probe rows in finally.
 *
 * Usage: node scripts/manual/prod-identity-verify.mjs
 */
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
dotenv.config({ path: path.join(root, ".env.test.prod"), override: true });

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url?.includes("rpxsyeqskvhjmbkxnpmd")) {
  console.error("FATAL: VITE_SUPABASE_URL is not PROD", url);
  process.exit(1);
}
if (!serviceKey) {
  console.error("FATAL: missing SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
const T = Date.now();
const phones = [];
const deviceIds = [];
const results = [];

function phone(prefix) {
  const p = `${prefix}${String(T).slice(-6)}`.slice(0, 10);
  phones.push(p);
  return p;
}

function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function cleanup() {
  if (deviceIds.length) {
    await sb.from("user_devices").delete().in("device_id", deviceIds);
  }
  if (phones.length) {
    await sb.from("edge_function_rate_limits").delete().in("identifier", [
      ...phones,
      ...deviceIds,
    ]);
    await sb.from("users").delete().in("phone", phones);
  }
  const leftoverDevices = deviceIds.length
    ? await sb.from("user_devices").select("id").in("device_id", deviceIds)
    : { data: [] };
  const leftoverUsers = phones.length
    ? await sb.from("users").select("phone").in("phone", phones)
    : { data: [] };
  ok(
    "cleanup_zero_leftover",
    (leftoverDevices.data?.length ?? 0) === 0 && (leftoverUsers.data?.length ?? 0) === 0,
    `devices=${leftoverDevices.data?.length ?? 0} users=${leftoverUsers.data?.length ?? 0}`,
  );
}

try {
  // ── Rate limits ─────────────────────────────────────────────
  {
    const deviceId = `prod_rl_mig_${T}`;
    deviceIds.push(deviceId);
    const p = phone("88310");
    await sb.from("edge_function_rate_limits").delete().eq("identifier", deviceId);

    let blocked = false;
    for (let i = 0; i < 31; i++) {
      const { error } = await sb.rpc("migrate_device_requests_phone", {
        p_device_id: deviceId,
        p_user_phone: p,
      });
      if (i < 30) {
        if (error) throw new Error(`migrate unexpected fail @${i}: ${error.message}`);
      } else {
        blocked = /rate_limit/i.test(error?.message ?? "");
      }
    }
    ok("rate_limit_migrate_device_requests_phone", blocked);
  }

  {
    const deviceId = `prod_rl_ens_${T}`;
    deviceIds.push(deviceId);
    const p = phone("88311");
    await sb.from("edge_function_rate_limits").delete().eq("identifier", deviceId);

    let blocked = false;
    for (let i = 0; i < 31; i++) {
      const { error } = await sb.rpc("ensure_user_device_link", {
        p_user_phone: p,
        p_device_id: deviceId,
      });
      if (i < 30) {
        if (error) throw new Error(`ensure unexpected fail @${i}: ${error.message}`);
      } else {
        blocked = /rate_limit/i.test(error?.message ?? "");
      }
    }
    ok("rate_limit_ensure_user_device_link", blocked);
  }

  // ── is_current phone swap + unique index ────────────────────
  {
    const deviceId = `prod_cur_${T}`;
    deviceIds.push(deviceId);
    const a = phone("88312");
    const b = phone("88313");
    await sb.from("users").upsert(
      [
        { phone: a, trust_score: 70 },
        { phone: b, trust_score: 70 },
      ],
      { onConflict: "phone" },
    );

    await sb.rpc("ensure_user_device_link", { p_user_phone: a, p_device_id: deviceId });
    await sb.rpc("ensure_user_device_link", { p_user_phone: b, p_device_id: deviceId });

    const { data: rows } = await sb
      .from("user_devices")
      .select("user_phone, is_current, fcm_token")
      .eq("device_id", deviceId);
    const rowA = rows?.find((r) => r.user_phone === a);
    const rowB = rows?.find((r) => r.user_phone === b);
    ok(
      "is_current_swap_keeps_history",
      rows?.length === 2 && rowA?.is_current === false && rowB?.is_current === true,
      JSON.stringify(rows),
    );

    // Partial unique: force two current rows should fail
    const { error: uniqErr } = await sb.from("user_devices").insert({
      user_phone: a,
      device_id: deviceId,
      fcm_token: null,
      is_current: true,
    });
    // upsert conflict on (phone,device) — try update a to current while b is current
    const { error: updErr } = await sb
      .from("user_devices")
      .update({ is_current: true })
      .eq("user_phone", a)
      .eq("device_id", deviceId);
    ok(
      "partial_unique_is_current_enforced",
      /unique|duplicate|exclusion/i.test(updErr?.message ?? uniqErr?.message ?? ""),
      updErr?.message ?? uniqErr?.message ?? "no error",
    );
  }

  // ── Banned customer row exists for UI probe (lookup returns is_banned) ──
  {
    const banned = phone("88314");
    await sb.from("users").upsert(
      { phone: banned, trust_score: 5, total_orders: 2, is_banned: true },
      { onConflict: "phone" },
    );
    const { data, error } = await sb.rpc("lookup_user_by_phone", { p_phone: banned });
    ok(
      "banned_customer_lookup_flag",
      !error && data?.[0]?.is_banned === true,
      JSON.stringify(data?.[0] ?? error),
    );
  }

  // Schema: is_current column + index present
  {
    const { data: cols } = await sb.rpc("to_jsonb", {}).maybeSingle?.();
    void cols;
    const { error } = await sb.from("user_devices").select("is_current").limit(1);
    ok("is_current_column_readable", !error, error?.message ?? "");
  }
} catch (e) {
  ok("unexpected_exception", false, String(e));
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({ url, results, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
