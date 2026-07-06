/**
 * Build gitignored .env.test.prod for one-off PROD Playwright runs.
 * Reads PROD service_role_key from app_config via linked Supabase CLI (not committed).
 * Usage: node scripts/build-env-test-prod.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const PROD_URL = 'https://rpxsyeqskvhjmbkxnpmd.supabase.co';
const PROD_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0';

const refFile = path.join(projectRoot, 'supabase', '.temp', 'project-ref');
if (!fs.existsSync(refFile)) {
  console.error('Supabase CLI not linked. Run: supabase link --project-ref rpxsyeqskvhjmbkxnpmd --yes');
  process.exit(1);
}
const linkedRef = fs.readFileSync(refFile, 'utf8').trim();
if (linkedRef !== 'rpxsyeqskvhjmbkxnpmd') {
  console.error(`CLI linked to ${linkedRef}, expected rpxsyeqskvhjmbkxnpmd`);
  process.exit(1);
}

const out = execSync(
  `supabase db query --linked -o json "SELECT value FROM app_config WHERE key = 'service_role_key' LIMIT 1;"`,
  { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
);
const jsonStart = out.indexOf('{');
const jsonEnd = out.lastIndexOf('}');
if (jsonStart < 0 || jsonEnd < jsonStart) {
  console.error('Could not parse supabase db query output for service_role_key');
  process.exit(1);
}

const parsed = JSON.parse(out.slice(jsonStart, jsonEnd + 1));
const serviceRoleKey = parsed?.rows?.[0]?.value?.trim();
if (!serviceRoleKey) {
  console.error('app_config.service_role_key is empty or missing on PROD');
  process.exit(1);
}

const backupPath = path.join(projectRoot, '.env.test.backup');
const template = fs.existsSync(backupPath)
  ? fs.readFileSync(backupPath, 'utf8')
  : fs.readFileSync(path.join(projectRoot, '.env.test'), 'utf8');

const browsersPath =
  template.match(/^PLAYWRIGHT_BROWSERS_PATH=(.+)$/m)?.[1]?.trim() ??
  './.playwright-browsers';

const outPath = path.join(projectRoot, '.env.test.prod');
const contents = `VITE_APP_URL=http://localhost:8081
VITE_SUPABASE_URL=${PROD_URL}
VITE_SUPABASE_ANON_KEY=${PROD_ANON}
TEST_ENV=test
SUPABASE_SERVICE_ROLE_KEY=${serviceRoleKey}
PLAYWRIGHT_BROWSERS_PATH=${browsersPath}
`;

fs.writeFileSync(outPath, contents, 'utf8');
console.log(`Wrote ${outPath} (PROD URL + anon + service role from app_config; not printed).`);
