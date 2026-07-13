/**
 * Full data wipe for TEST or PROD Supabase — preserves seed/config + one admin Auth user.
 *
 * Never deletes rows from: app_config, categories, category_translations
 * Never modifies schema / migrations / functions / RLS / cron.
 *
 * Usage (do not run until reviewed):
 *   node scripts/full-data-wipe.mjs --project=test
 *   node scripts/full-data-wipe.mjs --project=prod --preserve-admin-uuid=<uuid>
 *
 * --preserve-admin-uuid is optional. When omitted, ALL auth.users are deleted
 * (including admin accounts). When provided, that one auth user is kept.
 *
 * Credentials:
 *   test → .env.test   (VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
 *   prod → .env.test.prod (same keys; URL must be PROD ref)
 *
 * Public-schema DELETEs run via `supabase db query --linked` inside one BEGIN/COMMIT.
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

/** Exact leaf→root delete order (no CASCADE reliance). */
const WIPE_TABLES = [
  'vendor_category_modes',
  'vendor_categories',
  'vendor_category_cancel_reasons',
  'vendor_availability_modes',
  'vendor_verification',
  'bill_edit_audit',
  'saved_vendors',
  'vendor_menu_items',
  'vendor_reviews',
  'order_items',
  'order_bills',
  'khata_transactions',
  'khata_ledger',
  'vendor_credits',
  'referrals',
  'user_flags',
  'feed_replies',
  'feed_flags',
  'feed_posts',
  'requests',
  'user_notifications',
  'user_addresses',
  'user_devices',
  'saved_vendor_removal_notices',
  'admin_actions',
  'edge_function_rate_limits',
  'fcm_delivery_log',
  '_test_otp_capture',
  'admin_alerts',
  'vendors',
  'app_users',
  'users',
];

const PRESERVED_TABLES = ['app_config', 'categories', 'category_translations'];

const STORAGE_BUCKETS = ['feed-images', 'shop-photos', 'vendor-docs', 'vendor-selfies'];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseArgs(argv) {
  let project = null;
  let preserveAdminUuid = null;

  for (const arg of argv) {
    if (arg.startsWith('--project=')) {
      project = arg.slice('--project='.length).trim().toLowerCase();
    } else if (arg.startsWith('--preserve-admin-uuid=')) {
      preserveAdminUuid = arg.slice('--preserve-admin-uuid='.length).trim();
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
  if (preserveAdminUuid != null && preserveAdminUuid !== '') {
    if (!UUID_RE.test(preserveAdminUuid)) {
      throw new Error(`Invalid --preserve-admin-uuid (not a UUID): ${preserveAdminUuid}`);
    }
  } else {
    preserveAdminUuid = null;
  }

  return { projectKey: project, preserveAdminUuid, project: PROJECTS[project] };
}

function loadEnvForProject(project) {
  const envPath = path.join(projectRoot, project.envFile);
  if (!fs.existsSync(envPath)) {
    throw new Error(`Env file not found: ${project.envFile}`);
  }
  // Override so a previously loaded .env.local cannot bleed into the wrong project.
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

      // Re-list same prefix until empty (handles >limit pages of files).
      if (filePaths.length === 0 && folders.length === 0) return;
      if (filePaths.length < limit && folders.length === 0) {
        // Might still have more pages
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

function buildPublicWipeSql(preserveAdminUuid) {
  const lines = [];
  lines.push('-- full-data-wipe public schema (single transaction)');
  lines.push('BEGIN;');
  lines.push("SELECT set_config('app.via_system_rpc', 'true', true);");
  lines.push('');
  lines.push('-- Clear NO ACTION FKs pointing at vendors (category/app_users rows kept until later)');
  lines.push(
    'UPDATE public.categories SET suggested_by_vendor_id = NULL WHERE suggested_by_vendor_id IS NOT NULL;',
  );
  lines.push(
    'UPDATE public.app_users SET referred_by_vendor_id = NULL WHERE referred_by_vendor_id IS NOT NULL;',
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
    lines.push(`WITH d AS (DELETE FROM public.${table} RETURNING 1)`);
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted) SELECT ${step}, '${table}', COUNT(*) FROM d;`,
    );
    lines.push('');
  });

  lines.push('-- Preserved tables still present (logged before wipe_log so operators can compare)');
  lines.push(
    `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1000, 'PRESERVED:app_config', COUNT(*)::bigint FROM public.app_config;`,
  );
  lines.push(
    `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1001, 'PRESERVED:categories', COUNT(*)::bigint FROM public.categories;`,
  );
  lines.push(
    `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1002, 'PRESERVED:category_translations', COUNT(*)::bigint FROM public.category_translations;`,
  );
  if (preserveAdminUuid) {
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1003, 'PRESERVED:admin_users_for_uuid', COUNT(*)::bigint
     FROM public.admin_users WHERE user_id = '${preserveAdminUuid}'::uuid;`,
    );
  } else {
    lines.push(
      `INSERT INTO _wipe_log (step, table_name, rows_deleted)
     SELECT 1003, 'PRESERVED:admin_users_for_uuid (N/A — no admin preserved)', 0::bigint;`,
    );
  }
  lines.push('');
  // Last SELECT wins for supabase db query --linked JSON output.
  lines.push('SELECT step, table_name, rows_deleted FROM _wipe_log ORDER BY step;');
  lines.push('');
  lines.push('COMMIT;');
  lines.push('');
  return lines.join('\n');
}

function buildAuthWipeSql(preserveAdminUuid) {
  if (!preserveAdminUuid) {
    return [
      '-- full-data-wipe auth.users (ALL users — no admin preserved)',
      'BEGIN;',
      'DELETE FROM auth.users;',
      `SELECT`,
      `  (SELECT COUNT(*)::bigint FROM auth.users) AS auth_users_remaining;`,
      'COMMIT;',
      '',
    ].join('\n');
  }

  return [
    '-- full-data-wipe auth.users (preserve one admin)',
    'BEGIN;',
    `DELETE FROM auth.users WHERE id IS DISTINCT FROM '${preserveAdminUuid}'::uuid;`,
    // Single final SELECT for CLI JSON output
    `SELECT`,
    `  (SELECT COUNT(*)::bigint FROM auth.users) AS auth_users_remaining,`,
    `  (SELECT email FROM auth.users WHERE id = '${preserveAdminUuid}'::uuid) AS preserved_email,`,
    `  (SELECT COUNT(*)::bigint FROM public.admin_users WHERE user_id = '${preserveAdminUuid}'::uuid) AS admin_users_rows_for_uuid;`,
    'COMMIT;',
    '',
  ].join('\n');
}

function runLinkedSql(sql, label) {
  const sqlPath = path.join(os.tmpdir(), `full-data-wipe-${label}-${Date.now()}.sql`);
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

async function preflight(db, project, preserveAdminUuid) {
  console.log('\n========== PREFLIGHT ==========');
  console.log(`Project:     ${project.label} (${project.ref})`);
  console.log(`Preserved:   ${PRESERVED_TABLES.join(', ')}`);

  let adminEmail = null;
  if (preserveAdminUuid) {
    console.log(`Admin UUID:  ${preserveAdminUuid}`);

    const { data: adminUser, error: adminErr } = await db.auth.admin.getUserById(preserveAdminUuid);
    if (adminErr || !adminUser?.user) {
      throw new Error(
        `Preserved admin UUID not found in auth.users: ${preserveAdminUuid}` +
          (adminErr ? ` (${adminErr.message})` : ''),
      );
    }
    adminEmail = adminUser.user.email ?? '(no email)';
    console.log(`Admin email: ${adminEmail}`);

    const { data: allowRow, error: allowErr } = await db
      .from('admin_users')
      .select('user_id')
      .eq('user_id', preserveAdminUuid)
      .maybeSingle();
    if (allowErr) throw new Error(`admin_users lookup: ${allowErr.message}`);
    if (!allowRow) {
      console.warn(
        'WARNING: preserved UUID is not in public.admin_users — auth row will be kept, but allowlist has no matching row.',
      );
    } else {
      console.log('admin_users: linked row present (will be left untouched).');
    }
  } else {
    console.log(
      'Admin UUID:  (none — ALL auth.users will be deleted, including admin accounts)',
    );
  }

  console.log('\nRow counts for tables that will be DELETED:');
  let total = 0;
  for (const table of WIPE_TABLES) {
    const n = await countTable(db, table);
    total += n;
    console.log(`  ${table.padEnd(36)} ${String(n).padStart(8)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(36)} ${String(total).padStart(8)}`);

  console.log('\nPreserved table counts (must remain after wipe):');
  for (const table of PRESERVED_TABLES) {
    const n = await countTable(db, table);
    console.log(`  ${table.padEnd(36)} ${String(n).padStart(8)}`);
  }

  const existingBuckets = await listExistingBuckets(db);
  console.log('\nStorage buckets (objects to empty; missing buckets skipped):');
  for (const bucket of STORAGE_BUCKETS) {
    if (!existingBuckets.has(bucket)) {
      console.log(`  ${bucket.padEnd(36)} SKIP (bucket does not exist)`);
      continue;
    }
    let objects;
    try {
      objects = await countObjectsViaStorageApi(db, bucket);
    } catch (e) {
      console.warn(`  ${bucket}: list failed (${e.message}) — will still attempt empty`);
      objects = -1;
    }
    console.log(
      `  ${bucket.padEnd(36)} ${objects < 0 ? '?'.padStart(8) : String(objects).padStart(8)} objects`,
    );
  }

  return { adminEmail, existingBuckets };
}

async function main() {
  const { projectKey, preserveAdminUuid, project } = parseArgs(process.argv.slice(2));
  const { url, key } = loadEnvForProject(project);
  assertCliLinked(project);

  console.log('=== FULL DATA WIPE (nothing deleted until confirmation) ===');
  console.log(`Target URL: ${url}`);

  const db = createServiceClient(url, key);
  const pre = await preflight(db, project, preserveAdminUuid);

  console.log('\n========== CONFIRMATION REQUIRED ==========');
  console.log(`Type exactly: ${project.confirmPhrase}`);
  const typed = await promptLine('> ');
  if (typed !== project.confirmPhrase) {
    console.error(
      `Confirmation mismatch (got ${JSON.stringify(typed)}). Aborting — nothing deleted.`,
    );
    process.exit(1);
  }

  console.log('\n========== 1/3 PUBLIC SCHEMA (single transaction) ==========');
  runLinkedSql(buildPublicWipeSql(preserveAdminUuid), `public-${projectKey}`);
  console.log(
    'Public-schema wipe committed. Per-table rows_deleted are in the CLI SELECT output above.',
  );
  console.log('\nDelete order executed (leaf → root):');
  WIPE_TABLES.forEach((t, i) => console.log(`  ${String(i + 1).padStart(2)}. ${t}`));

  console.log('\n========== 2/3 AUTH USERS ==========');
  if (!preserveAdminUuid) {
    console.log('No --preserve-admin-uuid: deleting ALL auth.users (including admins).');
  }
  runLinkedSql(buildAuthWipeSql(preserveAdminUuid), `auth-${projectKey}`);

  if (preserveAdminUuid) {
    const { data: adminAfter, error: adminAfterErr } = await db.auth.admin.getUserById(
      preserveAdminUuid,
    );
    if (adminAfterErr || !adminAfter?.user) {
      throw new Error(
        `FATAL: preserved admin auth user missing after auth wipe: ${preserveAdminUuid}`,
      );
    }
    console.log(
      `Preserved admin still present: ${adminAfter.user.id} <${adminAfter.user.email ?? 'no-email'}>`,
    );

    const { data: allowAfter, error: allowAfterErr } = await db
      .from('admin_users')
      .select('user_id')
      .eq('user_id', preserveAdminUuid)
      .maybeSingle();
    if (allowAfterErr) throw new Error(`admin_users post-check: ${allowAfterErr.message}`);
    if (!allowAfter) {
      throw new Error(
        'FATAL: public.admin_users row for preserved admin is missing after wipe (should have been untouched).',
      );
    }
    console.log('admin_users row for preserved admin still present.');
  } else {
    console.log('Preserved-admin post-check skipped (not applicable — no admin preserved).');
  }

  console.log('\n========== 3/3 STORAGE ==========');
  for (const bucket of STORAGE_BUCKETS) {
    if (!pre.existingBuckets.has(bucket)) {
      console.log(`  ${bucket}: skipped (does not exist)`);
      continue;
    }
    const removed = await emptyBucket(db, bucket);
    console.log(`  ${bucket}: removed ${removed} object path(s)`);
  }

  console.log('\n========== DONE ==========');
  console.log(`Project ${project.label} wipe finished.`);
  if (preserveAdminUuid) {
    console.log(`Preserved admin: ${preserveAdminUuid} <${pre.adminEmail}>`);
  } else {
    console.log('Preserved admin: none (all auth.users wiped)');
  }
  console.log(`Preserved tables: ${PRESERVED_TABLES.join(', ')}`);
}

main().catch((err) => {
  console.error('\nWIPE FAILED:', err?.message ?? err);
  process.exit(1);
});
