/**
 * globalSetup for playwright.prod-full.config.ts — proves helpers target PROD
 * before any test runs. Read-only select via service-role client (no seeds).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getServiceRoleClient, getSupabaseUrl, loadTestEnv } from './testEnv';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';

export default async function prodFullGlobalSetup() {
  process.env.TEST_ENV = 'test.prod';
  loadTestEnv();

  const url = getSupabaseUrl();
  if (!url.includes(PROD_REF)) {
    throw new Error(`prodFullGlobalSetup: expected PROD ${PROD_REF}, got ${url}`);
  }

  const admin = getServiceRoleClient();
  const { data, error } = await admin.from('app_config').select('key').limit(3);
  if (error) {
    throw new Error(`prodFullGlobalSetup: PROD select failed: ${error.message}`);
  }
  if (!data?.length) {
    throw new Error('prodFullGlobalSetup: PROD app_config returned no rows');
  }

  const proof = {
    confirmed_at: new Date().toISOString(),
    supabase_url: url,
    project_ref: PROD_REF,
    rest_ok: true,
    sample_keys: data.map((r) => r.key).filter(Boolean).slice(0, 5),
  };

  const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const outPath = path.join(outDir, 'prod-full-target-proof.json');
  fs.writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(
    `[prod-full] CONFIRMED PROD target ${url} keys=${proof.sample_keys.join(',')}`,
  );
}
