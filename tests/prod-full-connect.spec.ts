/**
 * Harmless PROD-full connectivity check — read-only REST via helpers.
 * Used once to confirm playwright.prod-full.config.ts targets PROD before
 * any full-suite run. Safe to leave in the suite (no seeds, no edge invokes).
 */
import { test, expect } from '@playwright/test';
import { getSupabaseUrl, getServiceRoleClient } from './helpers/testEnv';

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';

test('PROD-FULL-CONNECT-01 — helpers point at PROD project ref', async () => {
  const url = getSupabaseUrl();
  expect(url, `expected PROD URL containing ${PROD_REF}, got ${url}`).toContain(PROD_REF);

  const admin = getServiceRoleClient();
  const { data, error } = await admin.from('app_config').select('key').limit(3);
  expect(error, error?.message).toBeNull();
  expect(Array.isArray(data)).toBe(true);
  expect((data?.length ?? 0) > 0).toBe(true);

  // Echo for the confirmation report (list reporter captures stdout).
  // eslint-disable-next-line no-console
  console.log(
    `PROD-FULL-CONNECT-01 hit ${url} keys=${(data ?? []).map((r) => r.key).join(',')}`,
  );
});
