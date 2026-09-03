/**
 * Enforced Supabase db push for TEST or PROD.
 *
 * Usage:
 *   node scripts/db-push.mjs test
 *   node scripts/db-push.mjs prod
 *   node scripts/db-push.mjs test --preflight-only
 *   node scripts/db-push.mjs test --dry-run
 *   node scripts/db-push.mjs prod --include-all
 *
 * SQL migrations must not rewrite Auth hook HMAC secrets. This wrapper always
 * passes --skip-vault. config.toml still requires SEND_SMS_HOOK_SECRET to be
 * v1,whsec_<base64> just to *parse*; if unset/malformed we inject a parse-only
 * placeholder so `db push` can run in a clean shell.
 *
 * Refuses to push if any version listed in supabase/deferred-migrations.json
 * appears as a file under supabase/migrations/ (the CLI would otherwise try
 * to apply it in chronological order and recreate PROD skip/repair friction).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PROJECT_REFS = {
  test: 'hhdylnhqdzfabsolwxdz',
  prod: 'rpxsyeqskvhjmbkxnpmd',
};

const migrationsDir = path.join(projectRoot, 'supabase', 'migrations');
const manifestPath = path.join(projectRoot, 'supabase', 'deferred-migrations.json');
const projectRefPath = path.join(projectRoot, 'supabase', '.temp', 'project-ref');

function usageAndExit(code = 1) {
  console.error(
    'Usage: node scripts/db-push.mjs test|prod [--preflight-only] [--dry-run] [--include-all]\n' +
      '  npm run db:push:test\n' +
      '  npm run db:push:prod\n' +
      '  npm run db:push:prod -- --include-all',
  );
  process.exit(code);
}

const envArg = (process.argv[2] ?? '').trim().toLowerCase();
const preflightOnly = process.argv.includes('--preflight-only');
const includeAll = process.argv.includes('--include-all');
const dryRun = process.argv.includes('--dry-run');

/** CLI rejects config.toml unless this matches v1,whsec_ + ≥32 chars of material. */
const SEND_SMS_HOOK_SECRET_RE = /^v1,whsec_.{32,}$/;
const CLI_PARSE_ONLY_SEND_SMS_HOOK_SECRET =
  'v1,whsec_' + Buffer.from('local-cli-config-placeholder-32', 'utf8').toString('base64');

function cliEnvWithParseableSendSmsHookSecret() {
  const env = { ...process.env };
  if (SEND_SMS_HOOK_SECRET_RE.test(env.SEND_SMS_HOOK_SECRET ?? '')) return env;
  console.warn(
    'SEND_SMS_HOOK_SECRET missing or not v1,whsec_<base64> (min 32 chars). ' +
      'Using a CLI parse-only placeholder; --skip-vault so Auth hook secrets are not overwritten.',
  );
  env.SEND_SMS_HOOK_SECRET = CLI_PARSE_ONLY_SEND_SMS_HOOK_SECRET;
  return env;
}

if (envArg !== 'test' && envArg !== 'prod') {
  usageAndExit(1);
}

const expectedRef = PROJECT_REFS[envArg];
const cliEnv = cliEnvWithParseableSendSmsHookSecret();

function loadManifest() {
  if (!fs.existsSync(manifestPath)) {
    console.error(`Missing deferred migrations manifest: ${manifestPath}`);
    process.exit(1);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    console.error(`Invalid JSON in ${manifestPath}: ${err.message}`);
    process.exit(1);
  }
  const deferred = Array.isArray(parsed?.deferred) ? parsed.deferred : null;
  if (!deferred) {
    console.error(`${manifestPath}: expected top-level "deferred" array`);
    process.exit(1);
  }
  return deferred;
}

function migrationVersion(filename) {
  const match = filename.match(/^(\d{14})_/);
  return match?.[1] ?? null;
}

function findDeferredInMigrations(deferredEntries) {
  const byVersion = new Map();
  for (const entry of deferredEntries) {
    const version = String(entry?.version ?? '').trim();
    if (!/^\d{14}$/.test(version)) {
      console.error(
        `Invalid deferred version in manifest (want 14 digits): ${JSON.stringify(entry?.version)}`,
      );
      process.exit(1);
    }
    byVersion.set(version, entry);
  }

  if (!fs.existsSync(migrationsDir)) {
    console.error(`Missing migrations directory: ${migrationsDir}`);
    process.exit(1);
  }

  const hits = [];
  for (const name of fs.readdirSync(migrationsDir)) {
    if (!name.endsWith('.sql')) continue;
    const version = migrationVersion(name);
    if (!version || !byVersion.has(version)) continue;
    hits.push({
      file: path.join('supabase', 'migrations', name),
      entry: byVersion.get(version),
    });
  }
  return hits;
}

function readLinkedRef() {
  if (!fs.existsSync(projectRefPath)) return null;
  return fs.readFileSync(projectRefPath, 'utf8').trim() || null;
}

function runSupabase(args, label) {
  console.log(`→ supabase ${args.join(' ')}`);
  // On Windows, .cmd shims require shell:true (spawnSync EINVAL otherwise).
  const result = spawnSync('npx', ['supabase', ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true,
    env: cliEnv,
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed (exit ${result.status ?? 'null'})`);
    process.exit(result.status ?? 1);
  }
}

const deferredEntries = loadManifest();
const hits = findDeferredInMigrations(deferredEntries);

console.log(`db-push preflight: env=${envArg} expected_ref=${expectedRef}`);
console.log(`deferred versions in manifest: ${deferredEntries.map((e) => e.version).join(', ') || '(none)'}`);

if (hits.length > 0) {
  console.error('');
  console.error('REFUSING db push: deferred migration version(s) found under supabase/migrations/.');
  console.error('The CLI would try to apply them in timestamp order and recreate skip/repair friction.');
  console.error('');
  for (const hit of hits) {
    console.error(`  blocked: ${hit.file}`);
    console.error(`  version: ${hit.entry.version}`);
    if (hit.entry.reason) console.error(`  reason:  ${hit.entry.reason}`);
    if (hit.entry.file) console.error(`  hold:    ${hit.entry.file}`);
    if (hit.entry.unblock) console.error(`  unblock: ${hit.entry.unblock}`);
    console.error('');
  }
  console.error(
    'Move the file back to supabase/migrations-deferred/ (or remove it). ' +
      'When ready to ship, add a NEW migration with a fresh timestamp — do not reuse the deferred version stamp.',
  );
  process.exit(1);
}

console.log('preflight ok: no deferred versions under supabase/migrations/');

if (preflightOnly) {
  console.log('preflight-only: skipping link + db push');
  process.exit(0);
}

const linked = readLinkedRef();
if (linked !== expectedRef) {
  console.log(
    `linked project-ref is ${linked ?? '(none)'}; linking ${envArg} (${expectedRef})…`,
  );
  runSupabase(['link', '--project-ref', expectedRef, '--yes'], 'supabase link');
} else {
  console.log(`linked project-ref ok: ${linked}`);
}

const pushArgs = ['db', 'push', '--yes', '--skip-vault'];
if (includeAll) {
  pushArgs.push('--include-all');
  console.log('passing --include-all (out-of-order local migrations ahead of remote tip)');
}
if (dryRun) {
  pushArgs.push('--dry-run');
  console.log('dry-run: migrations will not be applied');
}
runSupabase(pushArgs, dryRun ? 'supabase db push --dry-run' : 'supabase db push');
console.log(
  `db push ${dryRun ? 'dry-run ' : ''}complete: env=${envArg} ref=${expectedRef}`,
);
