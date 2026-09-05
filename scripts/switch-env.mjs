/**
 * Switch .env.development between TEST and PROD Supabase projects.
 * Usage: node scripts/switch-env.mjs test|prod
 *
 * Anon keys only — never put service role keys here.
 * Publishable keys are read from the shell at runtime (never hardcoded):
 *   TEST → TEST_SUPABASE_ANON_KEY
 *   PROD → PROD_SUPABASE_ANON_KEY
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env.development');

const PROJECT_URLS = {
  test: 'https://hhdylnhqdzfabsolwxdz.supabase.co',
  prod: 'https://rpxsyeqskvhjmbkxnpmd.supabase.co',
};

const ANON_KEY_ENV = {
  test: 'TEST_SUPABASE_ANON_KEY',
  prod: 'PROD_SUPABASE_ANON_KEY',
};

const target = (process.argv[2] ?? '').trim().toLowerCase();
if (target !== 'test' && target !== 'prod') {
  console.error(
    `Usage: node scripts/switch-env.mjs test|prod\n` +
      `Got: ${process.argv[2] === undefined ? '(missing)' : JSON.stringify(process.argv[2])}`,
  );
  process.exit(1);
}

if (!fs.existsSync(envPath)) {
  console.error(`Missing ${envPath}`);
  process.exit(1);
}

const anonKeyEnvName = ANON_KEY_ENV[target];
const anonKey = (process.env[anonKeyEnvName] ?? '').trim();
if (!anonKey) {
  console.error(
    `Set ${anonKeyEnvName} in your shell before running this script for ${target}.`,
  );
  process.exit(1);
}

const values = {
  VITE_ENVIRONMENT: target,
  VITE_SUPABASE_URL: PROJECT_URLS[target],
  VITE_SUPABASE_ANON_KEY: anonKey,
};

const original = fs.readFileSync(envPath, 'utf8');

// Do not rewrite VITE_OTP_ENABLED — leave whatever is already in .env.development
// (OTP cutover is a deliberate flag flip, not an env-switch side effect).
const KEYS = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_ENVIRONMENT',
]);

const finalContent = original
  .split(/\r?\n/)
  .map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return line;
    const key = match[1];
    if (!KEYS.has(key)) return line;
    // Only update VITE_ENVIRONMENT if it already exists in the file.
    if (key === 'VITE_ENVIRONMENT') {
      return `VITE_ENVIRONMENT=${values.VITE_ENVIRONMENT}`;
    }
    return `${key}=${values[key]}`;
  })
  .join(original.includes('\r\n') ? '\r\n' : '\n');

const otpLine = original.match(/^VITE_OTP_ENABLED=(.*)$/m)?.[1] ?? '(unset — left unchanged)';

console.log(`Switching env: development → ${target}`);
console.log(`VITE_SUPABASE_URL=${values.VITE_SUPABASE_URL}`);
console.log(`VITE_SUPABASE_ANON_KEY source: ${anonKeyEnvName}`);
console.log(`VITE_OTP_ENABLED left as-is: ${otpLine}`);

fs.writeFileSync(envPath, finalContent, 'utf8');

if (target === 'prod') {
  console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║  ⚠️  DEV SERVER IS NOW POINTED AT PRODUCTION.                            ║
║  Real vendor/customer data.                                              ║
║  Restart your dev server, and run                                        ║
║    node scripts/switch-env.mjs test                                      ║
║  when done testing.                                                      ║
╚══════════════════════════════════════════════════════════════════════════╝
`);
}

console.log(
  'Restart your dev server now for this to take effect (Vite does not hot-reload env changes).',
);
