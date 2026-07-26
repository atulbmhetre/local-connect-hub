/**
 * Full data wipe v2 — rebuilt against post-drift-fix schema (Jul 2026).
 * Do NOT lightly edit scripts/full-data-wipe.mjs (Session 65); this is the new entrypoint.
 *
 * Preserves: app_config, categories, category_translations, notification_i18n
 * Wipes: all other public user/business tables (36), optional auth.users, all storage objects
 *   in feed-images / menu-photos / shop-photos / vendor-docs / vendor-selfies
 *
 * Usage:
 *   node scripts/full-data-wipe-v2.mjs --project=test --dry-run
 *   node scripts/full-data-wipe-v2.mjs --project=test --dry-run --preserve-admin-uuid=<uuid>,<uuid>
 *   node scripts/full-data-wipe-v2.mjs --project=prod --preserve-admin-uuid=<uuid>
 *   node scripts/full-data-wipe-v2.mjs --project=prod
 *
 * --preserve-admin-uuid accepts one or more comma-separated UUIDs. Each kept auth.users
 * row AND its matching public.admin_users row survive the wipe.
 * When omitted, ALL auth.users (and all admin_users) are deleted.
 *
 * Credentials: test → .env.test ; prod → .env.test.prod
 * Public DELETEs run via `supabase db query --linked` inside one BEGIN/COMMIT.
 * CLI must already be linked to the same project as --project=…
 */
import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PROJECTS = {
  test: {
    label: 'TEST',
    ref: 'hhdylnhqdzfabsolwxdz',
    envFile: '.env.test',
    confirmPhrase: 'WIPE TEST',
  },
  prod: {
    label: 'PROD',
    ref: 'rpxsyeqskvhjmbkxnpmd',
    envFile: '.env.test.prod',
    confirmPhrase: 'WIPE PROD',
  },
};

/** Confirmed leaf→root delete order (explicit; no CASCADE reliance). */
const WIPE_TABLES = [
  '_test_otp_capture',
  'admin_actions',
  'admin_alerts',
  'admin_users', // special-cased when --preserve-admin-uuid list is set
  'edge_function_rate_limits',
  'fcm_delivery_log',
  'firstopen_restore_log',
  'radar_search_log',
  'user_addresses',
  'user_devices',
  'user_notifications',
  'saved_vendor_removal_notices',
  'users',
  'app_users',
  'feed_flags',
  'feed_replies',
  'feed_posts',
  'vendor_category_modes',
  'vendor_categories',
  'vendor_category_cancel_reasons',
  'vendor_availability_modes',
  'vendor_verification',
  'vendor_devices',
  'vendor_menu_items',
  'vendor_reviews',
  'saved_vendors',
  'bill_edit_audit',
  'order_items',
  'order_bills',
  'khata_transactions',
  'khata_ledger',
  'user_flags',
  'vendor_credits',
  'referrals',
  'requests',
  'vendors',
];

const PRESERVED_TABLES = [
  'app_config',
  'categories',
  'category_translations',
  'notification_i18n',
];

const STORAGE_BUCKETS = [
  'feed-images',
  'menu-photos',
  'shop-photos',
  'vendor-docs',
  'vendor-selfies',
];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePreserveAdminUuids(raw) {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('--preserve-admin-uuid= requires at least one UUID');
  }
  const seen = new Set();
  const uuids = [];
  for (const part of parts) {
    if (!UUID_RE.test(part)) {
      throw new Error(`Invalid --preserve-admin-uuid entry (not a UUID): ${part}`);
    }
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uuids.push(part);
  }
  return uuids;
}

/** SQL fragment: ARRAY['uuid'::uuid, ...] */
function sqlUuidArray(uuids) {
  return `ARRAY[${uuids.map((u) => `'${u}'::uuid`).join(', ')}]`;
}

function parseArgs(argv) {
  let project = null;
  let preserveAdminUuids = [];
  let dryRun = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length).trim().toLowerCase();
    } else if (arg.startsWith('--preserve-admin-uuid=')) {
      preserveAdminUuids = parsePreserveAdminUuids(
        arg.slice('--preserve-admin-uuid='.length),
      );
    } else if (arg === '--project' || arg === '--preserve-admin-uuid') {
      throw new Error(`Use ${arg}=<value> (equals form required)`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!project) {
    throw new Error(
      'Missing required --project=test|prod (no default — refuse to run without it).',
    );
  }
  if (!PROJECTS[project]) {
    throw new Error(`Invalid --project=${project}. Allowed: test, prod.`);
  }

  return { projectKey: project, preserveAdminUuids, dryRun, project: PROJECTS[project] };
}

function loadEnvForProject(project) {
  const envPath = path.join(projectRoot, project.envFile);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${project.envFile}`);
  }
  dotenv.config({ path: envPath, override: true });

  const url = (process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) {
    throw new Error(
      `Missing VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in ${project.envFile}`,
    );
  }
  if (!url.includes(project.ref)) {
    throw new Error(
      `Refusing: URL in ${project.envFile} does not contain project ref ${project.ref} (got ${url}).`,
    );
  }
  return { url, key };
}

function assertCliLinked(project) {
  const refFile = path.join(projectRoot, 'supabase', '.temp', 'project-ref');
  if (!fs.existsSync(refFile)) {
    throw new Error(
      `Supabase CLI not linked. Run: npx supabase link --project-ref ${project.ref} --yes`,
    );
  }
  const linkedRef = fs.readFileSync(refFile, 'utf8').trim();
  if (linkedRef !== project.ref) {
    throw new Error(
      `CLI linked to ${linkedRef}, expected ${project.ref}. Re-link before wipe:\n` +
        `  npx supabase link --project-ref ${project.ref} --yes`,
    );
  }
}

function createServiceClient(url, key) {
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function countTable(db, table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function countAdminUsersToDelete(db, preserveAdminUuids) {
  let q = db.from('admin_users').select('*', { count: 'exact', head: true });
  if (preserveAdminUuids.length > 0) {
    q = q.not('user_id', 'in', `(${preserveAdminUuids.join(',')})`);
  }
  const { count, error } = await q;
  if (error) throw new Error(`count admin_users: ${error.message}`);
  return count ?? 0;
}

async function countAdminUsersPreserved(db, preserveAdminUuids) {
  if (preserveAdminUuids.length === 0) return 0;
  const { count, error } = await db
    .from('admin_users')
    .select('*', { count: 'exact', head: true })
    .in('user_id', preserveAdminUuids);
  if (error) throw new Error(`count preserved admin_users: ${error.message}`);
  return count ?? 0;
}

async function countSuggestedByVendorNulls(db) {
  const { count, error } = await db
    .from('categories')
    .select('*', { count: 'exact', head: true })
    .not('suggested_by_vendor_id', 'is', null);
  if (error) throw new Error(`count categories.suggested_by_vendor_id: ${error.message}`);
  return count ?? 0;
}

async function listAuthUsers(db) {
  // Paginate — Auth Admin listUsers is capped per page.
  const users = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`auth.admin.listUsers: ${error.message}`);
    const batch = data?.users ?? [];
    users.push(...batch);
    if (batch.length < perPage) break;
    page += 1;
    if (page > 200) break;
  }
  return users;
}

async function listExistingBuckets(db) {
  const { data, error } = await db.storage.listBuckets();
  if (error) throw new Error(`listBuckets: ${error.message}`);
  return new Set((data ?? []).map((b) => b.id || b.name));
}

async function countObjectsViaStorageApi(db, bucketId) {
  let total = 0;

  async function walk(prefix) {
    const limit = 100;
    let offset = 0;
    for (;;) {
      const { data, error } = await db.storage.from(bucketId).list(prefix, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`storage.list ${bucketId}/${prefix}: ${error.message}`);
      const entries = data ?? [];
      if (entries.length === 0) return;

      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) {
          const next = prefix ? `${prefix}/${entry.name}` : entry.name;
          await walk(next);
        } else {
          total += 1;
        }
      }

      if (entries.length < limit) return;
      offset += limit;
      if (offset > 100_000) return;
    }
  }

  await walk('');
  return total;
}

async function emptyBucket(db, bucketId) {
  let removed = 0;

  async function wipePrefix(prefix) {
    const limit = 100;
    for (;;) {
      const { data, error } = await db.storage.from(bucketId).list(prefix, {
        limit,
        sortBy: { column: 'name', order: 'asc' },
      });
      if (error) throw new Error(`storage.list ${bucketId}/${prefix}: ${error.message}`);
      const entries = data ?? [];
      if (entries.length === 0) return;

      const folders = [];
      const filePaths = [];
      for (const entry of entries) {
        const isFolder = entry.id == null && entry.metadata == null;
        if (isFolder) {
          folders.push(entry.name);
        } else {
          filePaths.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }

      if (filePaths.length > 0) {
        const { error: rmErr } = await db.storage.from(bucketId).remove(filePaths);
        if (rmErr) throw new Error(`storage.remove ${bucketId}: ${rmErr.message}`);
        removed += filePaths.length;
      }

      for (const folder of folders) {
        const next = prefix ? `${prefix}/${folder}` : folder;
        await wipePrefix(next);
      }

      if (filePaths.length === 0 && folders.length === 0) return;
      if (filePaths.length < limit && folders.length === 0) {
        if (entries.length < limit) return;
      }
    }
  }

  await wipePrefix('');
  return removed;
}

function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function buildPublicWipeSql(preserveAdminUuids) {
  const lines = [];
  lines.push('-- full-data-wipe-v2 public schema (single transaction)');
  lines.push('BEGIN;');
  lines.push("SELECT set_config('app.via_system_rpc', 'true', true);");
  lines.push('');
  lines.push('-- Preserve categories rows; clear NO ACTION pointer into vendors');
  lines.push(
    'UPDATE public.categories SET suggested_by_vendor_id = NULL WHERE suggested_by_vendor_id IS NOT NULL;',
  );
  lines.push('');
  lines.push('CREATE TEMP TABLE _wipe_log (');
  lines.push('  step int PRIMARY KEY,');
  lines.push('  table_name text NOT NULL,');
  lines.push('  rows_deleted bigint NOT NULL');
  lines.push(') ON COMMIT DROP;');
  lines.push('');

  WIPE_TABLES.forEach((table, i) => {
    const step = i + 1;
    if (table === 'admin_users' && preserveAdminUuids.length > 0) {
      lines.push(
        `WITH d AS (DELETE FROM public.admin_users WHERE NOT (user_id = ANY (${sqlUuidArray(preserveAdminUuids)})) RETURNING 1)`,
      );
    } else {
      lines.push(`WITH d AS (DELETE FROM public.${table} RETURNING 1)`);
    }
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted) SELECT ${step}, '${table}', COUNT(*) FROM d;`,
    );
    lines.push('');
  });

  lines.push('-- Preserved tables still present (logged for operator comparison)');
  PRESERVED_TABLES.forEach((table, i) => {
    const step = 1000 + i;
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT ${step}, 'PRESERVED:${table}', COUNT(*)::bigint FROM public.${table};`,
    );
  });
  if (preserveAdminUuids.length > 0) {
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1100, 'PRESERVED:admin_users', COUNT(*)::bigint
     FROM public.admin_users WHERE user_id = ANY (${sqlUuidArray(preserveAdminUuids)});`,
    );
  }
  lines.push('');
  lines.push('SELECT step, table_name, rows_deleted FROM _wipe_log ORDER BY step;');
  lines.push('');
  lines.push('COMMIT;');
  lines.push('');
  return lines.join('\n');
}

function buildAuthWipeSql(preserveAdminUuids) {
  if (preserveAdminUuids.length === 0) {
    return [
      '-- full-data-wipe-v2 auth.users (ALL users — no admin preserved)',
      'BEGIN;',
      'DELETE FROM auth.users;',
      'SELECT (SELECT COUNT(*)::bigint FROM auth.users) AS auth_users_remaining;',
      'COMMIT;',
      '',
    ].join('\n');
  }

  return [
    '-- full-data-wipe-v2 auth.users (preserve listed admins)',
    'BEGIN;',
    `DELETE FROM auth.users WHERE NOT (id = ANY (${sqlUuidArray(preserveAdminUuids)}));`,
    `SELECT`,
    `  (SELECT COUNT(*)::bigint FROM auth.users) AS auth_users_remaining,`,
    `  (SELECT COUNT(*)::bigint FROM auth.users WHERE id = ANY (${sqlUuidArray(preserveAdminUuids)})) AS preserved_auth_users,`,
    `  (SELECT COUNT(*)::bigint FROM public.admin_users WHERE user_id = ANY (${sqlUuidArray(preserveAdminUuids)})) AS preserved_admin_users_rows;`,
    'COMMIT;',
    '',
  ].join('\n');
}

function runLinkedSql(sql, label) {
  const sqlPath = path.join(os.tmpdir(), `full-data-wipe-v2-${label}-${Date.now()}.sql`);
  fs.writeFileSync(sqlPath, sql, 'utf8');
  console.log(`\n--- Running SQL via CLI (${label}) ---`);
  console.log(`SQL file: ${sqlPath}`);

  const result = spawnSync(
    'npx',
    ['supabase', 'db', 'query', '--linked', '-f', sqlPath],
    { cwd: projectRoot, encoding: 'utf8', shell: true },
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    throw new Error(
      `supabase db query failed for ${label} (exit ${result.status}). ` +
        'If this was the public-schema step, the transaction should have rolled back.',
    );
  }

  return result.stdout ?? '';
}

async function reportDryRun(db, project, preserveAdminUuids) {
  console.log('\n========== DRY-RUN (no deletes) ==========');
  console.log(`Project:   ${project.label} (${project.ref})`);
  console.log(`Preserved: ${PRESERVED_TABLES.join(', ')}`);
  if (preserveAdminUuids.length > 0) {
    console.log(`Admin UUIDs kept (${preserveAdminUuids.length}):`);
    for (const id of preserveAdminUuids) console.log(`  - ${id}`);
  } else {
    console.log('Admin UUIDs kept: (none — ALL auth.users would be deleted)');
  }

  const nullCount = await countSuggestedByVendorNulls(db);
  console.log(
    `\nPre-step UPDATE categories.suggested_by_vendor_id → NULL: ${nullCount} row(s)`,
  );

  console.log('\nPublic tables that WOULD be DELETED (child→parent order):');
  let publicTotal = 0;
  for (let i = 0; i < WIPE_TABLES.length; i++) {
    const table = WIPE_TABLES[i];
    let n;
    if (table === 'admin_users') {
      n = await countAdminUsersToDelete(db, preserveAdminUuids);
    } else {
      n = await countTable(db, table);
    }
    publicTotal += n;
    const note =
      table === 'admin_users' && preserveAdminUuids.length > 0
        ? ` (excluding ${preserveAdminUuids.length} preserved uuid(s))`
        : '';
    console.log(
      `  ${String(i + 1).padStart(2)}. ${table.padEnd(36)} ${String(n).padStart(8)}${note}`,
    );
  }
  console.log(`  ${'PUBLIC TOTAL'.padEnd(40)} ${String(publicTotal).padStart(8)}`);

  console.log('\nPreserved table counts (must remain after a real wipe):');
  for (const table of PRESERVED_TABLES) {
    const n = await countTable(db, table);
    console.log(`  ${table.padEnd(36)} ${String(n).padStart(8)}`);
  }
  if (preserveAdminUuids.length > 0) {
    const keptAdmins = await countAdminUsersPreserved(db, preserveAdminUuids);
    console.log(
      `  ${'admin_users (preserved uuids)'.padEnd(36)} ${String(keptAdmins).padStart(8)}` +
        ` / ${preserveAdminUuids.length} requested`,
    );
  }

  const authUsers = await listAuthUsers(db);
  const preserveSet = new Set(preserveAdminUuids);
  const authDelete =
    preserveAdminUuids.length > 0
      ? authUsers.filter((u) => !preserveSet.has(u.id))
      : authUsers;
  const authKeep = authUsers.length - authDelete.length;
  console.log(
    `\nauth.users that WOULD be DELETED: ${authDelete.length}` +
      (preserveAdminUuids.length > 0
        ? ` (keeping ${authKeep} of ${authUsers.length})`
        : ` (all ${authUsers.length})`),
  );

  if (preserveAdminUuids.length > 0) {
    for (const uid of preserveAdminUuids) {
      const { data: adminUser, error: adminErr } = await db.auth.admin.getUserById(uid);
      if (adminErr || !adminUser?.user) {
        console.warn(`WARNING: preserved UUID not found in auth.users: ${uid}`);
      } else {
        console.log(
          `  preserved auth user present: ${adminUser.user.id} <${adminUser.user.email ?? 'no-email'}>`,
        );
      }
      const { data: allowRow, error: allowErr } = await db
        .from('admin_users')
        .select('user_id')
        .eq('user_id', uid)
        .maybeSingle();
      if (allowErr) throw new Error(`admin_users lookup: ${allowErr.message}`);
      if (!allowRow) {
        console.warn(
          `WARNING: preserved UUID has no public.admin_users row: ${uid}`,
        );
      } else {
        console.log(`  public.admin_users row present for ${uid}`);
      }
    }
  }

  const existingBuckets = await listExistingBuckets(db);
  console.log('\nStorage objects that WOULD be removed:');
  for (const bucket of STORAGE_BUCKETS) {
    if (!existingBuckets.has(bucket)) {
      console.log(`  ${bucket.padEnd(36)} SKIP (bucket does not exist)`);
      continue;
    }
    let objects;
    try {
      objects = await countObjectsViaStorageApi(db, bucket);
    } catch (e) {
      console.warn(`  ${bucket}: list failed (${e.message})`);
      objects = -1;
    }
    console.log(
      `  ${bucket.padEnd(36)} ${objects < 0 ? '?'.padStart(8) : String(objects).padStart(8)} objects`,
    );
  }

  console.log('\nDRY-RUN complete — nothing was deleted.');
}

async function runWipe(db, projectKey, project, preserveAdminUuids) {
  console.log('\n========== CONFIRMATION REQUIRED ==========');
  console.log(`Type exactly: ${project.confirmPhrase}`);
  const typed = await promptLine('> ');
  if (typed !== project.confirmPhrase) {
    console.error(
      `Confirmation mismatch (got ${JSON.stringify(typed)}). Aborting — nothing deleted.`,
    );
    process.exit(1);
  }

  const existingBuckets = await listExistingBuckets(db);

  console.log('\n========== 1/3 PUBLIC SCHEMA (single transaction) ==========');
  runLinkedSql(buildPublicWipeSql(preserveAdminUuids), `public-${projectKey}`);
  console.log('Public-schema wipe committed.');
  console.log('\nDelete order executed (child → parent):');
  WIPE_TABLES.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}`));

  console.log('\n========== 2/3 AUTH USERS ==========');
  if (preserveAdminUuids.length === 0) {
    console.log('No --preserve-admin-uuid: deleting ALL auth.users (including admins).');
  } else {
    console.log(`Preserving ${preserveAdminUuids.length} auth.users uuid(s).`);
  }
  runLinkedSql(buildAuthWipeSql(preserveAdminUuids), `auth-${projectKey}`);

  for (const uid of preserveAdminUuids) {
    const { data: adminAfter, error: adminAfterErr } = await db.auth.admin.getUserById(uid);
    if (adminAfterErr || !adminAfter?.user) {
      throw new Error(`FATAL: preserved admin auth user missing after auth wipe: ${uid}`);
    }
    console.log(
      `Preserved admin still present: ${adminAfter.user.id} <${adminAfter.user.email ?? 'no-email'}>`,
    );

    const { data: allowAfter, error: allowAfterErr } = await db
      .from('admin_users')
      .select('user_id')
      .eq('user_id', uid)
      .maybeSingle();
    if (allowAfterErr) throw new Error(`admin_users post-check: ${allowAfterErr.message}`);
    if (!allowAfter) {
      throw new Error(
        `FATAL: public.admin_users row for preserved admin is missing after wipe: ${uid}`,
      );
    }
    console.log(`admin_users row still present for ${uid}`);
  }

  console.log('\n========== 3/3 STORAGE (outside SQL transaction) ==========');
  for (const bucket of STORAGE_BUCKETS) {
    if (!existingBuckets.has(bucket)) {
      console.log(`  ${bucket}: skipped (does not exist)`);
      continue;
    }
    const removed = await emptyBucket(db, bucket);
    console.log(`  ${bucket}: removed ${removed} object path(s)`);
  }

  console.log('\n========== DONE ==========');
  console.log(`Project ${project.label} wipe finished.`);
  console.log(`Preserved tables: ${PRESERVED_TABLES.join(', ')}`);
  if (preserveAdminUuids.length > 0) {
    console.log(`Preserved admin uuids: ${preserveAdminUuids.join(', ')}`);
  } else {
    console.log('Preserved admin: none (all auth.users wiped)');
  }
}

async function main() {
  const { projectKey, preserveAdminUuids, dryRun, project } = parseArgs(
    process.argv.slice(2),
  );
  const { url, key } = loadEnvForProject(project);
  assertCliLinked(project);

  console.log(dryRun ? '=== FULL DATA WIPE v2 — DRY-RUN ===' : '=== FULL DATA WIPE v2 ===');
  console.log(`Target: ${project.label} (${project.ref})`);
  console.log(`URL:    ${url}`);
  console.log(`Wipe tables: ${WIPE_TABLES.length}`);
  console.log(`Buckets:     ${STORAGE_BUCKETS.join(', ')}`);

  const db = createServiceClient(url, key);

  if (dryRun) {
    await reportDryRun(db, project, preserveAdminUuids);
    return;
  }

  // Real wipe: print counts first, then require typed confirmation.
  await reportDryRun(db, project, preserveAdminUuids);
  await runWipe(db, projectKey, project, preserveAdminUuids);
}

main().catch((err) => {
  console.error('\nWIPE FAILED:', err?.message ?? err);
  process.exit(1);
});
