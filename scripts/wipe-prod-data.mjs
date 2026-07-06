/**
 * PROD data wipe — preserves seed/config only (categories, category_translations, app_config).
 *
 * Dry-run (default — counts only, no deletes):
 *   node scripts/wipe-prod-data.mjs
 *
 * Execute wipe (destructive — requires Supabase CLI linked to PROD):
 *   node scripts/wipe-prod-data.mjs --confirm-wipe-prod
 *
 * Env for dry-run counts (service role):
 *   PROD_SUPABASE_URL  — must contain rpxsyeqskvhjmbkxnpmd
 *   PROD_SUPABASE_SERVICE_ROLE_KEY
 *
 * Execute path runs: supabase db query --linked -f <generated-sql>
 * (CLI must be linked to rpxsyeqskvhjmbkxnpmd; script verifies project-ref file)
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(projectRoot, '.env.local') });

const PROD_PROJECT_REF = 'rpxsyeqskvhjmbkxnpmd';

/** Public tables wiped — all except preserved seed/config (27 of 29 public tables). */
const WIPE_TABLES = [
  '_test_otp_capture',
  'admin_actions',
  'admin_alerts',
  'app_users',
  'bill_edit_audit',
  'fcm_delivery_log',
  'feed_flags',
  'feed_posts',
  'feed_replies',
  'khata_ledger',
  'khata_transactions',
  'order_bills',
  'order_items',
  'referrals',
  'requests',
  'saved_vendors',
  'user_addresses',
  'user_devices',
  'user_flags',
  'user_notifications',
  'users',
  'vendor_categories',
  'vendor_credits',
  'vendor_menu_items',
  'vendor_reviews',
  'vendor_verification',
  'vendors',
];

const PRESERVED_TABLES = ['categories', 'category_translations', 'app_config'];

function parseArgs(argv) {
  return { confirm: argv.includes('--confirm-wipe-prod') };
}

function resolveProdClient() {
  const url = (process.env.PROD_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim();
  const key = (
    process.env.PROD_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    ''
  ).trim();

  if (!url || !key) {
    console.error(
      'Missing PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE_KEY (or VITE_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).',
    );
    process.exit(1);
  }

  if (!url.includes(PROD_PROJECT_REF)) {
    console.error(
      `Refusing to run: URL must target PROD project ${PROD_PROJECT_REF} (got ${url}).`,
    );
    process.exit(1);
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

function assertLinkedToProd() {
  const refFile = path.join(projectRoot, 'supabase', '.temp', 'project-ref');
  if (!fs.existsSync(refFile)) {
    console.error(
      'Supabase CLI not linked. Run: supabase link --project-ref rpxsyeqskvhjmbkxnpmd --yes',
    );
    process.exit(1);
  }
  const linkedRef = fs.readFileSync(refFile, 'utf8').trim();
  if (linkedRef !== PROD_PROJECT_REF) {
    console.error(
      `CLI linked to ${linkedRef}, expected ${PROD_PROJECT_REF}. Re-link before wipe.`,
    );
    process.exit(1);
  }
}

async function countTable(db, table) {
  const { count, error } = await db.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function dryRun(db) {
  console.log('=== PROD DATA WIPE — DRY RUN (no deletes) ===');
  console.log(`Project: ${PROD_PROJECT_REF}`);
  console.log(`Preserved: ${PRESERVED_TABLES.join(', ')}`);
  console.log(`Would wipe ${WIPE_TABLES.length} tables:\n`);

  let total = 0;
  for (const table of WIPE_TABLES) {
    const count = await countTable(db, table);
    total += count;
    console.log(`  ${table.padEnd(24)} ${String(count).padStart(8)} rows`);
  }

  console.log(`\n  ${'TOTAL'.padEnd(24)} ${String(total).padStart(8)} rows`);
  console.log('\nNot touched: auth.users / auth.identities (Supabase Auth schema).');
}

function buildTruncateSql() {
  const names = WIPE_TABLES.map((t) => `public.${t}`).join(',\n  ');
  return `-- Generated PROD wipe — preserves categories, category_translations, app_config\nTRUNCATE TABLE\n  ${names}\nRESTART IDENTITY CASCADE;\n`;
}

function executeWipeViaCli() {
  assertLinkedToProd();
  const sqlPath = path.join(os.tmpdir(), `wipe-prod-data-${Date.now()}.sql`);
  const sql = buildTruncateSql();
  fs.writeFileSync(sqlPath, sql, 'utf8');

  console.log('\n=== PROD DATA WIPE — EXECUTING TRUNCATE ===');
  console.warn('WARNING: Permanently deleting all rows in listed tables.\n');
  console.log(sql);

  execSync(`supabase db query --linked -f "${sqlPath}"`, {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  console.log('\nTRUNCATE completed.');
}

async function main() {
  const { confirm } = parseArgs(process.argv.slice(2));
  const db = resolveProdClient();

  await dryRun(db);

  if (!confirm) {
    console.log('\nRe-run with --confirm-wipe-prod to execute TRUNCATE ... CASCADE.');
    return;
  }

  executeWipeViaCli();
  console.log('\nPost-wipe verification:');
  await dryRun(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
