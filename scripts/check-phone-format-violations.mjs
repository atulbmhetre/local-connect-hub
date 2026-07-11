/**
 * Read-only: rows in vendors/users that would violate phone format CHECK.
 * Usage: node scripts/check-phone-format-violations.mjs [test|prod|both]
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const VALID = /^[6-9][0-9]{9}$/;
function isAllowedPhone(phone) {
  if (phone == null) return false;
  return VALID.test(phone) || phone.startsWith('deleted_');
}

async function fetchAll(admin, table) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from(table)
      .select('id, phone')
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function checkEnv(label, url, serviceKey) {
  console.log(`\n========== ${label} ==========`);
  console.log(`URL: ${url}`);
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const table of ['vendors', 'users']) {
    const rows = await fetchAll(admin, table);
    const violations = rows.filter((r) => !isAllowedPhone(r.phone));
    console.log(`\n${table}: ${rows.length} total, ${violations.length} violations`);
    if (violations.length) {
      const sample = violations.slice(0, 50).map((r) => ({
        id: r.id,
        phone: r.phone,
        len: r.phone?.length ?? 0,
      }));
      console.log(JSON.stringify(sample, null, 2));
      if (violations.length > 50) {
        console.log(`... and ${violations.length - 50} more`);
      }
    }
  }
}

function loadTest() {
  dotenv.config({ path: path.join(projectRoot, '.env.test') });
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.test');
  return { url, key };
}

function loadProd() {
  const prodEnv = path.join(projectRoot, '.env.test.prod');
  if (fs.existsSync(prodEnv)) {
    dotenv.config({ path: prodEnv });
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (url?.includes('rpxsyeqskvhjmbkxnpmd') && key) return { url, key };
  }
  const url = 'https://rpxsyeqskvhjmbkxnpmd.supabase.co';
  dotenv.config({ path: path.join(projectRoot, '.env.local') });
  const key = process.env.PROD_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY_PROD;
  if (key) return { url, key };
  throw new Error('PROD credentials not found (.env.test.prod or PROD_SUPABASE_SERVICE_ROLE_KEY)');
}

const mode = process.argv[2] ?? 'both';

try {
  if (mode === 'test' || mode === 'both') {
    const t = loadTest();
    await checkEnv('TEST', t.url, t.key);
  }
  if (mode === 'prod' || mode === 'both') {
    const p = loadProd();
    await checkEnv('PROD', p.url, p.key);
  }
} catch (err) {
  console.error(err.message || err);
  process.exit(1);
}
