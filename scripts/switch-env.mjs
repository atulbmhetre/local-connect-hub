/**
 * Switch .env.development between TEST and PROD Supabase projects.
 * Usage: node scripts/switch-env.mjs test|prod
 *
 * Anon keys only — never put service role keys here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env.development');

const ENVS = {
  test: {
    VITE_ENVIRONMENT: 'test',
    VITE_SUPABASE_URL: 'https://hhdylnhqdzfabsolwxdz.supabase.co',
    VITE_SUPABASE_ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhoZHlsbmhxZHpmYWJzb2x3eGR6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0NDQ0ODEsImV4cCI6MjA5NjAyMDQ4MX0.CWGB3IcOmFK7NsHIy6bgPulRfVGRuDxXDzdEZ7V777s',
  },
  prod: {
    VITE_ENVIRONMENT: 'prod',
    VITE_SUPABASE_URL: 'https://rpxsyeqskvhjmbkxnpmd.supabase.co',
    VITE_SUPABASE_ANON_KEY:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0',
  },
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

const values = ENVS[target];
const original = fs.readFileSync(envPath, 'utf8');

const KEYS = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_ENVIRONMENT',
]);

const updated = original
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

console.log(`Switching env: development → ${target}`);
console.log(`VITE_SUPABASE_URL=${values.VITE_SUPABASE_URL}`);

fs.writeFileSync(envPath, updated, 'utf8');

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
