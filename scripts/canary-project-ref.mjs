/**
 * Canary: confirm Playwright env points at expected Supabase project.
 * Usage: node scripts/canary-project-ref.mjs > canary_before.txt 2>&1
 *
 * Loads dotenv from CANARY_ENV_FILE (default .env.test.prod).
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const envFile = process.env.CANARY_ENV_FILE ?? '.env.test.prod';
const envPath = path.resolve(projectRoot, envFile);

if (!fs.existsSync(envPath)) {
  console.error(`Missing env file: ${envPath}`);
  process.exit(1);
}

dotenv.config({ path: envPath, override: true });

const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();

const refMatch = url.match(/https:\/\/([^.]+)\.supabase\.co/);
const projectRef = refMatch?.[1] ?? '(unknown)';

console.log('=== Supabase canary ===');
console.log(`env_file: ${envFile}`);
console.log(`VITE_SUPABASE_URL: ${url}`);
console.log(`project_ref: ${projectRef}`);
console.log(`has_anon_key: ${anonKey.length > 0}`);
console.log(`has_service_role_key: ${serviceKey.length > 0}`);

if (!url || !serviceKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const db = createClient(url, serviceKey, { auth: { persistSession: false } });

const { count, error } = await db
  .from('vendors')
  .select('*', { count: 'exact', head: true });

if (error) {
  console.error(`ERROR: vendors count failed: ${error.message}`);
  process.exit(1);
}

console.log(`vendors_row_count: ${count ?? 0}`);
console.log('canary_status: ok');
