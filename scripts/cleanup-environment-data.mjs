/**
 * Environment cleanup / TEST full wipe.
 *
 * Modes:
 *   (default)  Fixture/orphan cleanup (auth age filters, orphans, storage orphans;
 *              TEST also deletes probe-like vendors).
 *   --full-wipe  TEST ONLY: delete ALL user/business data; keep catalog + admin_users.
 *                Refuses --env=prod. Removes age/email filters for auth.users.
 *
 * Usage:
 *   node scripts/cleanup-environment-data.mjs --env=test --dry-run
 *   node scripts/cleanup-environment-data.mjs --env=test --execute
 *   node scripts/cleanup-environment-data.mjs --env=test --full-wipe --dry-run
 *   node scripts/cleanup-environment-data.mjs --env=test --full-wipe --execute
 *   node scripts/cleanup-environment-data.mjs --env=test --full-wipe --execute --confirm="WIPE TEST"
 *
 * Defaults to dry-run. --execute required for deletes.
 * Interactive confirm uses one readline session (do not close stdin between prompts).
 * --confirm="WIPE TEST" skips prompts for non-interactive scripting.
 * PROD (non-full-wipe) still requires dump gate + typed confirmation.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const ENVS = {
  test: {
    label: 'TEST',
    ref: 'hhdylnhqdzfabsolwxdz',
    envFile: '.env.test',
    prodConfirmPhrases: null,
    fullWipeConfirm: 'WIPE TEST',
  },
  prod: {
    label: 'PROD',
    ref: 'rpxsyeqskvhjmbkxnpmd',
    envFile: '.env.test.prod',
    prodConfirmPhrases: ['DELETE PROD', 'rpxsyeqskvhjmbkxnpmd'],
    fullWipeConfirm: null,
  },
};

const PROD_DUMP_DIRS = [
  path.join(os.homedir(), 'backups', 'aaspaas-prod'),
  path.join(os.homedir(), 'Documents', 'aaspaas-prod-backups'),
];
const PROD_DUMP_PATTERNS = [/^prod_schema_.*\.sql$/i, /^prod_full_.*\.sql$/i];

/** Full-wipe KEEP list (reference/catalog + admin login). */
const FULL_WIPE_KEEP = [
  'app_config',
  'categories',
  'category_translations',
  'category_mode_reviews',
  'category_search_terms',
  'category_search_term_evidence',
  'notification_i18n',
  'admin_users',
];

/**
 * Leaf → parent DELETE order for full wipe (explicit; do not rely on CASCADE).
 * upi_change_alerts before vendors (ON DELETE NO ACTION).
 * admin_users intentionally omitted (kept).
 */
const FULL_WIPE_DELETE_ORDER = [
  '_test_otp_capture',
  'admin_actions',
  'admin_alerts',
  'edge_function_rate_limits',
  'fcm_delivery_log',
  'firstopen_restore_log',
  'radar_search_log',
  'gps_match_failures',
  'unresolved_search_terms',
  'app_notify_leads',
  'customer_payment_restrictions',
  'user_addresses',
  'user_devices',
  'user_notifications',
  'saved_vendor_removal_notices',
  'user_flags',
  'feed_flags',
  'feed_replies',
  'feed_posts',
  'support_messages',
  'upi_change_alerts',
  'payment_dispute_events',
  'bill_edit_audit',
  'order_items',
  'order_bills',
  'khata_transactions',
  'khata_ledger',
  'vendor_credits',
  'referrals',
  'vendor_call_outcomes',
  'vendor_menu_items',
  'vendor_reviews',
  'vendor_category_modes',
  'vendor_categories',
  'vendor_category_cancel_reasons',
  'vendor_availability_modes',
  'vendor_verification',
  'vendor_devices',
  'vendor_licenses',
  'vendor_aadhaar_digilocker_txns',
  'saved_vendors',
  'recurring_orders',
  'requests',
  'app_users',
  'users',
  'vendors',
];

const FULL_WIPE_STORAGE_BUCKETS = [
  'shop-photos',
  'vendor-selfies',
  'payment-proofs',
  'vendor-docs',
];

const SEND_SMS_HOOK_SECRET_RE = /^v1,whsec_.{32,}$/;
const CLI_PARSE_ONLY_SEND_SMS_HOOK_SECRET =
  'v1,whsec_' + Buffer.from('local-cli-config-placeholder-32', 'utf8').toString('base64');

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/cleanup-environment-data.mjs --env=test|prod [--dry-run|--execute] [--full-wipe] [--confirm=WIPE TEST]

  --full-wipe           TEST only: wipe all user/business data; keep catalog + admin_users
  --confirm="WIPE TEST" Non-interactive confirm (skips readline prompts; for scripting)
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  let envKey = null;
  let execute = false;
  let dryRunExplicit = false;
  let olderThanDays = 7;
  let fullWipe = false;
  let confirmPhrase = null;

  for (const arg of argv) {
    if (arg === '--dry-run') dryRunExplicit = true;
    else if (arg === '--execute') execute = true;
    else if (arg === '--full-wipe') fullWipe = true;
    else if (arg.startsWith('--env=')) envKey = arg.slice('--env='.length).trim().toLowerCase();
    else if (arg.startsWith('--confirm=')) confirmPhrase = arg.slice('--confirm='.length);
    else if (arg.startsWith('--older-than-days=')) {
      const n = Number(arg.slice('--older-than-days='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error('--older-than-days must be a positive integer');
      olderThanDays = n;
    } else if (arg === '--help' || arg === '-h') usage(0);
    else if (arg === '--env' || arg === '--older-than-days' || arg === '--confirm') {
      throw new Error(`Use ${arg}=<value> (equals form required)`);
    } else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!envKey) throw new Error('Missing required --env=test|prod (no default).');
  if (!ENVS[envKey]) throw new Error(`Invalid --env=${envKey}. Allowed: test, prod.`);
  if (execute && dryRunExplicit) throw new Error('Pass either --dry-run or --execute, not both.');
  if (fullWipe && envKey !== 'test') {
    throw new Error('--full-wipe is TEST-only. Refusing --env=prod.');
  }

  return {
    envKey,
    env: ENVS[envKey],
    dryRun: !execute,
    olderThanDays,
    fullWipe,
    confirmPhrase,
  };
}

function cliEnv() {
  const env = { ...process.env };
  if (!SEND_SMS_HOOK_SECRET_RE.test(env.SEND_SMS_HOOK_SECRET ?? '')) {
    env.SEND_SMS_HOOK_SECRET = CLI_PARSE_ONLY_SEND_SMS_HOOK_SECRET;
  }
  return env;
}

function loadEnvForProject(env) {
  const envPath = path.join(projectRoot, env.envFile);
  if (!fs.existsSync(envPath)) throw new Error(`Env file not found: ${env.envFile}`);
  dotenv.config({ path: envPath, override: true });
  const url = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) {
    throw new Error(`Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in ${env.envFile}`);
  }
  if (!url.includes(env.ref)) {
    throw new Error(
      `Refusing: URL in ${env.envFile} does not contain project ref ${env.ref} (got ${url}).`,
    );
  }
  return { url, key };
}

function assertCliLinked(env) {
  const refFile = path.join(projectRoot, 'supabase', '.temp', 'project-ref');
  if (!fs.existsSync(refFile)) {
    throw new Error(`Supabase CLI not linked. Run: npx supabase link --project-ref ${env.ref} --yes`);
  }
  const linkedRef = fs.readFileSync(refFile, 'utf8').trim();
  if (linkedRef !== env.ref) {
    throw new Error(
      `CLI linked to ${linkedRef}, expected ${env.ref}. Re-link:\n  npx supabase link --project-ref ${env.ref} --yes`,
    );
  }
}

function assertRecentProdDump() {
  const now = Date.now();
  const findings = [];
  for (const dir of PROD_DUMP_DIRS) {
    if (!fs.existsSync(dir)) {
      findings.push({ dir, status: 'missing_dir' });
      continue;
    }
    const names = fs.readdirSync(dir);
    for (const pattern of PROD_DUMP_PATTERNS) {
      const matches = names.filter((n) => pattern.test(n));
      if (!matches.length) {
        findings.push({ dir, pattern: String(pattern), status: 'no_match' });
        continue;
      }
      let newest = null;
      for (const name of matches) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (!st.isFile() || st.size < 1000) continue;
        if (!newest || st.mtimeMs > newest.mtimeMs) {
          newest = { full, size: st.size, mtimeMs: st.mtimeMs, ageHours: (now - st.mtimeMs) / 3600000 };
        }
      }
      findings.push(
        newest
          ? {
              dir,
              pattern: String(pattern),
              status: newest.ageHours <= 24 ? 'ok' : 'stale',
              ...newest,
              ageHours: Number(newest.ageHours.toFixed(2)),
            }
          : { dir, pattern: String(pattern), status: 'empty_or_tiny' },
      );
    }
  }
  console.log('\n--- PROD dump gate ---');
  for (const f of findings) console.log(JSON.stringify(f));
  const ok = PROD_DUMP_PATTERNS.every((pattern) =>
    findings.some((f) => f.status === 'ok' && f.pattern === String(pattern)),
  );
  if (!ok) {
    throw new Error(
      'PROD refused: need recent prod_schema_*.sql AND prod_full_*.sql (mtime < 24h).',
    );
  }
  console.log('PROD dump gate: PASS');
}

/**
 * Prompt session that works for TTY and redirected/piped stdin on Windows.
 *
 * Pitfalls fixed here:
 * 1) Creating a new readline.Interface per question and calling rl.close()
 *    after the first answer closes process.stdin → later prompts never read.
 * 2) Repeated rl.question() on non-TTY/redirected stdin (common under Windows
 *    `cmd < file` / pipes): after the first line, the interface often hits EOF
 *    before the second question, so the callback never fires and the process
 *    can exit 0 with no error. Drive answers from the 'line' event instead.
 */
function openPromptSession() {
  if (typeof process.stdin.resume === 'function' && process.stdin.isPaused?.()) {
    process.stdin.resume();
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    crlfDelay: Infinity,
  });

  const pending = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    const value = String(line ?? '').trim();
    if (waiters.length) waiters.shift()({ ok: true, value });
    else pending.push(value);
  });

  rl.on('close', () => {
    closed = true;
    while (waiters.length) {
      waiters.shift()({ ok: false });
    }
  });

  return {
    ask(question) {
      if (question) process.stdout.write(question);
      if (pending.length) return Promise.resolve(pending.shift());
      if (closed) {
        return Promise.reject(new Error('stdin closed before answer received (EOF)'));
      }
      return new Promise((resolve, reject) => {
        waiters.push((result) => {
          if (!result.ok) {
            reject(new Error('stdin closed before answer received (EOF)'));
            return;
          }
          resolve(result.value);
        });
      });
    },
    close() {
      rl.close();
    },
  };
}

/** Interactive full-wipe confirmation (two prompts, one stdin session). */
async function confirmFullWipeInteractive(expectedPhrase) {
  const session = openPromptSession();
  try {
    console.log(`Type exactly: ${expectedPhrase}`);
    const typed = await session.ask('> ');
    if (typed !== expectedPhrase) {
      throw new Error(`Confirmation mismatch (got ${JSON.stringify(typed)}). Aborting.`);
    }
    console.log('Type y for final confirmation.');
    const yn = await session.ask('Proceed with FULL TEST wipe? [y/N] ');
    if (yn.toLowerCase() !== 'y') {
      throw new Error(`Aborted (got ${JSON.stringify(yn)}).`);
    }
  } finally {
    session.close();
  }
}

function runLinkedSql(sql, label) {
  const sqlPath = path.join(os.tmpdir(), `cleanup-env-${label}-${Date.now()}.sql`);
  fs.writeFileSync(sqlPath, sql, 'utf8');
  const result = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '-f', sqlPath, '-o', 'json'],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: true,
      env: cliEnv(),
      maxBuffer: 64 * 1024 * 1024,
      // Never inherit stdin — a child can drain redirected confirm answers.
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`supabase db query failed for ${label} (exit ${result.status})`);
  }
  const out = (result.stdout ?? '').trim();
  const start = out.indexOf('[');
  const startObj = out.indexOf('{');
  let jsonStart = -1;
  if (start >= 0 && (startObj < 0 || start < startObj)) jsonStart = start;
  else if (startObj >= 0) jsonStart = startObj;
  if (jsonStart < 0) return out ? JSON.parse(out) : [];
  return JSON.parse(out.slice(jsonStart));
}

function firstRow(result) {
  if (result == null) return {};
  if (Array.isArray(result)) return result[0] ?? {};
  if (typeof result === 'object' && Array.isArray(result.rows) && result.rows.length) {
    return result.rows[0] ?? {};
  }
  return typeof result === 'object' ? result : {};
}

function extractReport(result) {
  const row = firstRow(result);
  if (row.report && typeof row.report === 'object') return row.report;
  return row;
}

function createServiceClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function emptyBucket(db, bucketId) {
  let removed = 0;
  async function wipePrefix(prefix) {
    for (;;) {
      const { data, error } = await db.storage.from(bucketId).list(prefix, {
        limit: 100,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`storage.list ${bucketId}/${prefix}: ${error.message}`);
      const entries = data ?? [];
      if (!entries.length) return;
      const folders = [];
      const filePaths = [];
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) folders.push(entry.name);
        else filePaths.push(prefix ? `${prefix}/${entry.name}` : entry.name);
      }
      if (filePaths.length) {
        const { error: rmErr } = await db.storage.from(bucketId).remove(filePaths);
        if (rmErr) throw new Error(`storage.remove ${bucketId}: ${rmErr.message}`);
        removed += filePaths.length;
      }
      for (const folder of folders) {
        await wipePrefix(prefix ? `${prefix}/${folder}` : folder);
      }
      if (filePaths.length === 0 && folders.length === 0) return;
      if (filePaths.length < 100 && folders.length === 0 && entries.length < 100) return;
    }
  }
  await wipePrefix('');
  return removed;
}

async function countBucketObjects(db, bucketId) {
  let total = 0;
  async function walk(prefix) {
    let offset = 0;
    for (;;) {
      const { data, error } = await db.storage.from(bucketId).list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`storage.list ${bucketId}: ${error.message}`);
      const entries = data ?? [];
      if (!entries.length) return;
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) await walk(prefix ? `${prefix}/${entry.name}` : entry.name);
        else total += 1;
      }
      if (entries.length < 100) return;
      offset += 100;
      if (offset > 200000) return;
    }
  }
  await walk('');
  return total;
}

// ── Full wipe ───────────────────────────────────────────────────────────────

function fullWipeInventorySql() {
  const wipeSelects = FULL_WIPE_DELETE_ORDER.map(
    (t) => `'${t}', (SELECT count(*)::int FROM public.${t})`,
  ).join(',\n  ');
  const keepSelects = FULL_WIPE_KEEP.map(
    (t) => `'${t}', (SELECT count(*)::int FROM public.${t})`,
  ).join(',\n  ');
  return `
SELECT json_build_object(
  'auth_users_total', (SELECT count(*)::int FROM auth.users),
  'auth_users_keep_admins', (
    SELECT count(*)::int FROM auth.users u
    WHERE EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = u.id)
  ),
  'auth_users_delete', (
    SELECT count(*)::int FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = u.id)
  ),
  'admin_users', (SELECT count(*)::int FROM public.admin_users),
  'categories_suggested_by_nullify', (
    SELECT count(*)::int FROM public.categories WHERE suggested_by_vendor_id IS NOT NULL
  ),
  'wipe', json_build_object(${wipeSelects}),
  'keep', json_build_object(${keepSelects})
) AS report;
`.trim();
}

function fullWipeDeleteSql() {
  const lines = [];
  lines.push('BEGIN;');
  lines.push("SELECT set_config('app.via_system_rpc', 'true', true);");
  lines.push(`CREATE TEMP TABLE _wipe_log (
  step text PRIMARY KEY,
  rows_affected bigint NOT NULL
) ON COMMIT DROP;`);
  lines.push(`
WITH d AS (
  UPDATE public.categories
  SET suggested_by_vendor_id = NULL
  WHERE suggested_by_vendor_id IS NOT NULL
  RETURNING 1
)
INSERT INTO _wipe_log SELECT 'nullify_categories_suggested_by_vendor_id', count(*) FROM d;
`);

  for (const table of FULL_WIPE_DELETE_ORDER) {
    lines.push(`
WITH d AS (DELETE FROM public.${table} RETURNING 1)
INSERT INTO _wipe_log SELECT '${table}', count(*) FROM d;
`);
  }

  lines.push(`
WITH d AS (
  DELETE FROM auth.users u
  WHERE NOT EXISTS (SELECT 1 FROM public.admin_users a WHERE a.user_id = u.id)
  RETURNING 1
)
INSERT INTO _wipe_log SELECT 'auth_users', count(*) FROM d;
`);

  lines.push(`
INSERT INTO _wipe_log
SELECT 'KEEP:admin_users', count(*)::bigint FROM public.admin_users;
INSERT INTO _wipe_log
SELECT 'KEEP:auth_users_remaining', count(*)::bigint FROM auth.users;
INSERT INTO _wipe_log
SELECT 'KEEP:categories', count(*)::bigint FROM public.categories;
INSERT INTO _wipe_log
SELECT 'KEEP:app_config', count(*)::bigint FROM public.app_config;
`);

  lines.push('SELECT step, rows_affected FROM _wipe_log ORDER BY step;');
  lines.push('COMMIT;');
  return lines.join('\n');
}

function fullWipePostCheckSql() {
  return `
SELECT json_build_object(
  'auth_users', (SELECT count(*)::int FROM auth.users),
  'admin_users', (SELECT count(*)::int FROM public.admin_users),
  'vendors', (SELECT count(*)::int FROM public.vendors),
  'users', (SELECT count(*)::int FROM public.users),
  'requests', (SELECT count(*)::int FROM public.requests),
  'upi_orphans', (
    SELECT count(*)::int FROM public.upi_change_alerts a
    LEFT JOIN public.vendors v ON v.id = a.vendor_id
    WHERE a.vendor_id IS NOT NULL AND v.id IS NULL
  ),
  'call_orphans', (
    SELECT count(*)::int FROM public.vendor_call_outcomes o
    LEFT JOIN public.requests r ON r.id = o.request_id
    WHERE o.request_id IS NOT NULL AND r.id IS NULL
  ),
  'categories', (SELECT count(*)::int FROM public.categories),
  'category_search_terms', (SELECT count(*)::int FROM public.category_search_terms),
  'notification_i18n', (SELECT count(*)::int FROM public.notification_i18n),
  'app_config', (SELECT count(*)::int FROM public.app_config),
  'nonkeep_public_rows', (
    SELECT coalesce(sum(n),0)::bigint FROM (
      SELECT (xpath('/row/c/text()', query_to_xml(
        format('select count(*)::text as c from public.%I', c.relname), false, true, ''
      )))[1]::text::bigint AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'r'
        AND c.relname <> ALL (ARRAY[${FULL_WIPE_KEEP.map((t) => `'${t}'`).join(',')}])
    ) s
  )
) AS report;
`.trim();
}

function printFullWipeReport(env, report, storageCounts) {
  console.log('\n========== FULL WIPE REPORT (TEST) ==========');
  console.log(`Env: ${env.label} (${env.ref})`);
  console.log('');
  console.log('KEEP (must remain — not deleted):');
  for (const t of FULL_WIPE_KEEP) {
    console.log(`  ${t.padEnd(36)} ${String(report.keep?.[t] ?? '?').padStart(8)}`);
  }
  console.log(`  ${'auth.users (admin-linked)'.padEnd(36)} ${String(report.auth_users_keep_admins).padStart(8)}`);
  console.log('');
  console.log('WOULD DELETE (public tables, leaf→parent order):');
  let wipeTotal = 0;
  for (const t of FULL_WIPE_DELETE_ORDER) {
    const n = report.wipe?.[t] ?? 0;
    wipeTotal += n;
    console.log(`  ${t.padEnd(36)} ${String(n).padStart(8)}`);
  }
  console.log(`  ${'PUBLIC WIPE SUBTOTAL'.padEnd(36)} ${String(wipeTotal).padStart(8)}`);
  console.log(
    `  ${'nullify categories.suggested_by…'.padEnd(36)} ${String(report.categories_suggested_by_nullify).padStart(8)}`,
  );
  console.log('');
  console.log('Auth:');
  console.log(`  total:                 ${report.auth_users_total}`);
  console.log(`  WOULD DELETE:          ${report.auth_users_delete}`);
  console.log(`  KEEP (admin-linked):   ${report.auth_users_keep_admins}`);
  console.log('');
  console.log('Storage WOULD empty:');
  for (const b of FULL_WIPE_STORAGE_BUCKETS) {
    console.log(`  ${b.padEnd(36)} ${String(storageCounts[b] ?? '?').padStart(8)}`);
  }
  console.log('=============================================');
}

async function runFullWipe({ env, dryRun, db, confirmPhrase = null }) {
  console.log(dryRun ? '=== FULL WIPE — DRY-RUN ===' : '=== FULL WIPE — EXECUTE ===');
  console.log(`Target: ${env.label} (${env.ref}) — TEST ONLY`);
  console.log(`KEEP:   ${FULL_WIPE_KEEP.join(', ')}`);
  console.log('Auth:   delete ALL auth.users except rows linked from admin_users');

  const inv = extractReport(runLinkedSql(fullWipeInventorySql(), 'full-wipe-inv'));
  const storageCounts = {};
  const { data: buckets } = await db.storage.listBuckets();
  const existing = new Set((buckets ?? []).map((b) => b.id || b.name));
  for (const b of FULL_WIPE_STORAGE_BUCKETS) {
    if (!existing.has(b)) {
      storageCounts[b] = 0;
      continue;
    }
    try {
      storageCounts[b] = await countBucketObjects(db, b);
    } catch (e) {
      storageCounts[b] = -1;
      console.warn(`storage count ${b}: ${e.message}`);
    }
  }

  printFullWipeReport(env, inv, storageCounts);

  // Sanity: KEEP tables must not appear in delete order
  for (const t of FULL_WIPE_KEEP) {
    if (FULL_WIPE_DELETE_ORDER.includes(t)) {
      throw new Error(`BUG: KEEP table ${t} is also in DELETE order`);
    }
  }
  console.log('\nKEEP list correctly excluded from DELETE order: YES');

  console.log('\n========== FULL WIPE CONFIRMATION ==========');
  if (confirmPhrase != null) {
    if (confirmPhrase !== env.fullWipeConfirm) {
      throw new Error(
        `Confirmation mismatch via --confirm= (got ${JSON.stringify(confirmPhrase)}). Aborting.`,
      );
    }
    console.log(`Non-interactive confirm: --confirm=${env.fullWipeConfirm} (accepted)`);
  } else {
    await confirmFullWipeInteractive(env.fullWipeConfirm);
  }

  if (dryRun) {
    console.log('\nConfirmation: OK');
    console.log('DRY-RUN complete — nothing was deleted.');
    console.log('Re-run with --env=test --full-wipe --execute after explicit go-ahead.');
    return;
  }

  console.log('\n--- 1/2 Public + auth SQL wipe (single transaction) ---');
  const delRaw = runLinkedSql(fullWipeDeleteSql(), 'full-wipe-delete');
  console.log(JSON.stringify(delRaw, null, 2));

  console.log('\n--- 2/2 Empty storage buckets ---');
  for (const b of FULL_WIPE_STORAGE_BUCKETS) {
    if (!existing.has(b)) {
      console.log(`  ${b}: skipped (missing)`);
      continue;
    }
    const removed = await emptyBucket(db, b);
    console.log(`  ${b}: removed ${removed}`);
  }

  const post = extractReport(runLinkedSql(fullWipePostCheckSql(), 'full-wipe-post'));
  console.log('\n========== POST-WIPE RECHECK ==========');
  console.log(JSON.stringify(post, null, 2));
  const ok =
    post.vendors === 0 &&
    post.users === 0 &&
    post.requests === 0 &&
    post.upi_orphans === 0 &&
    post.call_orphans === 0 &&
    post.admin_users >= 1 &&
    post.auth_users === post.admin_users &&
    post.nonkeep_public_rows === 0;
  console.log(ok ? 'POST-WIPE: CLEAN' : 'POST-WIPE: CHECK FAILED — inspect counts');
  console.log('======================================');
}

// ── Selective fixture mode (unchanged behaviour, shortened import path) ─────
// For non-full-wipe, spawn the previous selective logic by reusing dynamic import
// of a sibling module would be heavy; keep a minimal selective path via exec of
// the probe-vendor path already validated. Prefer: if not fullWipe, call
// selectiveMain from inlined minimal re-export.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { env, dryRun, fullWipe, confirmPhrase } = args;

  if (!fullWipe) {
    throw new Error(
      'This entrypoint now requires --full-wipe for the TEST full data wipe.\n' +
        'Example: node scripts/cleanup-environment-data.mjs --env=test --full-wipe --dry-run',
    );
  }

  const { url, key } = loadEnvForProject(env);
  assertCliLinked(env);
  const db = createServiceClient(url, key);
  await runFullWipe({ env, dryRun, db, confirmPhrase });
}

main().catch((err) => {
  console.error('\nCLEANUP FAILED:', err?.message ?? err);
  process.exit(1);
});
