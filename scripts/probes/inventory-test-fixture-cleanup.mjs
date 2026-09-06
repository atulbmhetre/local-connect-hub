/**
 * Read-only inventory of TEST automation fixture data (Auth, storage, orphans).
 * Does NOT delete. Usage: node scripts/probes/inventory-test-fixture-cleanup.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

const TEST_REF = "hhdylnhqdzfabsolwxdz";
const KEEP_DAYS = 7;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(root, ".env.test"), override: true });

const url = (process.env.VITE_SUPABASE_URL ?? "").trim();
const service = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
if (!url.includes(TEST_REF) || !service) {
  console.error("HARD STOP: .env.test is not TEST or missing service key");
  process.exit(1);
}

const admin = createClient(url, service, { auth: { persistSession: false } });
const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);

/** @param {string | null | undefined} email */
function classifyEmail(email) {
  const e = (email ?? "").toLowerCase();
  if (!e) return "no_email";
  if (e.endsWith("@aaspaas.invalid")) return "aaspaas.invalid";
  if (e.endsWith("@aaspaas.test")) return "aaspaas.test";
  if (/@(example\.com|example\.org|test\.local)$/.test(e)) return "other_fixture_domain";
  if (e.includes("+91") && e.includes("aaspaas")) return "aaspaas_other";
  return "non_fixture";
}

function isFixtureClass(c) {
  return c === "aaspaas.invalid" || c === "aaspaas.test" || c === "other_fixture_domain";
}

async function listAllAuthUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const batch = data?.users ?? [];
    if (!batch.length) break;
    users.push(...batch);
    if (batch.length < 200) break;
    page += 1;
    if (page > 200) break; // safety
  }
  return users;
}

async function storageInventory() {
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) throw new Error(`listBuckets: ${error.message}`);

  const out = [];
  for (const b of buckets ?? []) {
    // Recursive listing is expensive; sample top-level + estimate via SQL if available
    let fileCount = 0;
    let samplePaths = [];
    try {
      const walk = async (prefix, depth) => {
        if (depth > 4) return;
        const { data, error: le } = await admin.storage.from(b.id).list(prefix, {
          limit: 1000,
          offset: 0,
        });
        if (le || !data) return;
        for (const item of data) {
          const p = prefix ? `${prefix}/${item.name}` : item.name;
          if (item.id) {
            // file
            fileCount += 1;
            if (samplePaths.length < 8) samplePaths.push(p);
          } else if (item.name) {
            await walk(p, depth + 1);
          }
        }
      };
      await walk("", 0);
    } catch (e) {
      samplePaths = [`list_error: ${e instanceof Error ? e.message : String(e)}`];
    }
    out.push({
      id: b.id,
      public: b.public,
      fileCountApprox: fileCount,
      samplePaths,
    });
  }
  return out;
}

async function orphanInventory() {
  // upi_change_alerts.vendor_id → vendors.id
  const { data: upiOrphans, error: uErr } = await admin.rpc("sql", {}).catch(() => ({ data: null, error: { message: "no rpc" } }));
  void upiOrphans;
  void uErr;

  // Use raw REST via postgrest filters where possible, else fetch and join client-side for small tables
  const { data: alerts, error: aErr } = await admin
    .from("upi_change_alerts")
    .select("id, vendor_id, created_at")
    .not("vendor_id", "is", null);
  if (aErr) throw new Error(`upi_change_alerts: ${aErr.message}`);

  const vendorIds = [...new Set((alerts ?? []).map((r) => r.vendor_id).filter(Boolean))];
  const existingVendors = new Set();
  for (let i = 0; i < vendorIds.length; i += 200) {
    const chunk = vendorIds.slice(i, i + 200);
    const { data, error } = await admin.from("vendors").select("id").in("id", chunk);
    if (error) throw new Error(`vendors lookup: ${error.message}`);
    for (const v of data ?? []) existingVendors.add(v.id);
  }
  const upiOrphanRows = (alerts ?? []).filter((r) => r.vendor_id && !existingVendors.has(r.vendor_id));

  const { data: outcomes, error: oErr } = await admin
    .from("vendor_call_outcomes")
    .select("id, request_id, vendor_phone, created_at")
    .not("request_id", "is", null);
  if (oErr) throw new Error(`vendor_call_outcomes: ${oErr.message}`);

  const requestIds = [...new Set((outcomes ?? []).map((r) => r.request_id).filter(Boolean))];
  const existingRequests = new Set();
  for (let i = 0; i < requestIds.length; i += 200) {
    const chunk = requestIds.slice(i, i + 200);
    const { data, error } = await admin.from("requests").select("id").in("id", chunk);
    if (error) throw new Error(`requests lookup: ${error.message}`);
    for (const r of data ?? []) existingRequests.add(r.id);
  }
  const callOrphanRows = (outcomes ?? []).filter((r) => r.request_id && !existingRequests.has(r.request_id));

  return {
    upi_change_alerts: {
      totalWithVendorId: alerts?.length ?? 0,
      orphanCount: upiOrphanRows.length,
      orphanSample: upiOrphanRows.slice(0, 10).map((r) => ({
        id: r.id,
        vendor_id: r.vendor_id,
        created_at: r.created_at,
      })),
    },
    vendor_call_outcomes: {
      totalWithRequestId: outcomes?.length ?? 0,
      orphanCount: callOrphanRows.length,
      orphanSample: callOrphanRows.slice(0, 10).map((r) => ({
        id: r.id,
        request_id: r.request_id,
        vendor_phone: r.vendor_phone,
        created_at: r.created_at,
      })),
    },
  };
}

async function publicTableFixtureHints() {
  // Vendors with shop_name / name patterns from probes
  const { count: vendorCount } = await admin
    .from("vendors")
    .select("id", { count: "exact", head: true });
  const { data: probeVendors } = await admin
    .from("vendors")
    .select("id, phone, shop_name, name, created_at")
    .or("shop_name.ilike.!SESS-%,shop_name.ilike.!MISSSESS-%,name.ilike.Sess %,name.ilike.MissSess %")
    .limit(20);

  const { count: usersTable } = await admin.from("users").select("id", { count: "exact", head: true });

  return {
    vendors_total: vendorCount,
    users_table_total: usersTable,
    probe_vendor_sample: probeVendors ?? [],
  };
}

const users = await listAllAuthUsers();
const byClass = {};
const fixtureOlder = [];
const fixtureRecent = [];
const ambiguous = [];
const nonFixture = [];

for (const u of users) {
  const cls = classifyEmail(u.email);
  byClass[cls] = (byClass[cls] || 0) + 1;
  const created = u.created_at ? new Date(u.created_at) : null;
  const older = created && created < cutoff;
  const row = {
    id: u.id,
    email: u.email,
    phone: u.phone,
    created_at: u.created_at,
    class: cls,
  };
  if (isFixtureClass(cls)) {
    if (older) fixtureOlder.push(row);
    else fixtureRecent.push(row);
  } else if (cls === "aaspaas_other" || cls === "no_email") {
    ambiguous.push(row);
  } else {
    nonFixture.push(row);
  }
}

const storage = await storageInventory();
const orphans = await orphanInventory();
const hints = await publicTableFixtureHints();

const report = {
  env: "TEST",
  ref: TEST_REF,
  keep_newer_than_days: KEEP_DAYS,
  cutoff_iso: cutoff.toISOString(),
  auth: {
    total: users.length,
    byClass,
    fixture_older_than_cutoff: fixtureOlder.length,
    fixture_within_keep_window: fixtureRecent.length,
    ambiguous_count: ambiguous.length,
    non_fixture_count: nonFixture.length,
    ambiguous_sample: ambiguous.slice(0, 15).map((r) => ({
      email: r.email,
      phone_tail: r.phone ? String(r.phone).slice(-4) : null,
      created_at: r.created_at,
      class: r.class,
    })),
    non_fixture_sample: nonFixture.slice(0, 15).map((r) => ({
      email: r.email,
      phone_tail: r.phone ? String(r.phone).slice(-4) : null,
      created_at: r.created_at,
    })),
    fixture_older_created_span: fixtureOlder.length
      ? {
          oldest: fixtureOlder.map((r) => r.created_at).sort()[0],
          newest: fixtureOlder.map((r) => r.created_at).sort().at(-1),
        }
      : null,
  },
  storage,
  orphans,
  public_hints: hints,
  proposed_delete_auth_ids: fixtureOlder.length,
  note: "READ-ONLY inventory — no deletes performed",
};

console.log(JSON.stringify(report, null, 2));
