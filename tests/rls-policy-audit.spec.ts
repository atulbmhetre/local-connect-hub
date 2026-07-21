/**
 * RLS policy audit — catches legacy "open" policies that silently survive migrations.
 *
 * WHY: On 2026-07-05, PROD still had 32 permissive RLS policies with USING/WITH CHECK = true
 * for anon/PUBLIC (e.g. order_bills_all, "Anyone can read users") because Phase C migrations
 * only dropped specifically-named anon_all policies — they never audited pg_policy for what
 * actually existed. Restrictive Phase C policies were added alongside open ones; permissive
 * OR logic meant the open policies still won. This test fails if that class of gap reappears.
 *
 * Env: loads RLS_AUDIT_ENV_FILE or CANARY_ENV_FILE (default .env.test). Use
 *   CANARY_ENV_FILE=.env.test.prod npx playwright test tests/rls-policy-audit.spec.ts
 * to audit PROD before migrations.
 */
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const envFile = process.env.RLS_AUDIT_ENV_FILE ?? process.env.CANARY_ENV_FILE ?? '.env.test';
dotenv.config({ path: path.resolve(process.cwd(), envFile), override: true });

/** Intentional SELECT-only public reads — any other true-expression anon/PUBLIC policy is a leak. */
const ALLOWED_ANON_TRUE_POLICIES = [
  {
    table: 'app_config',
    policy: 'app_config_public_read',
    command: 'SELECT' as const,
    reason: 'Public app_config keys (feature flags, copy) for unauthenticated clients.',
  },
  {
    table: 'categories',
    policy: 'categories_public_read',
    command: 'SELECT' as const,
    reason: 'Category list for home/browse before sign-in.',
  },
  {
    table: 'category_translations',
    policy: 'category_translations_public_read',
    command: 'SELECT' as const,
    reason: 'Localized category labels for anonymous browse.',
  },
  {
    table: 'notification_i18n',
    policy: 'notification_i18n_public_read',
    command: 'SELECT' as const,
    reason: 'Localized SQL notification copy templates (en/hi/mr); writes via migrations only.',
  },
  {
    table: 'feed_replies',
    policy: 'feed_replies_public_read',
    command: 'SELECT' as const,
    reason: 'Public feed thread replies (writes gated elsewhere).',
  },
  {
    table: 'vendor_menu_items',
    policy: 'vendor_menu_items_public_read',
    command: 'SELECT' as const,
    reason: 'Vendor menu visible on public vendor profile.',
  },
  {
    table: 'vendor_reviews',
    policy: 'vendor_reviews_public_read',
    command: 'SELECT' as const,
    reason: 'Public review list on vendor profile.',
  },
  // vendors is intentionally absent: the old wide-open vendors_public_read
  // (USING true) was replaced by vendors_public_discoverable_read, which has a
  // real predicate (discoverable AND NOT banned AND profile complete) and so
  // no longer qualifies as an open anon true-expression policy.
] as const;

type AuditPolicyRow = {
  table_name: string;
  policy_name: string;
  command: string;
  roles?: unknown;
  is_public_role?: boolean;
  using_expr?: string | null;
  with_check_expr?: string | null;
};

type AuditResult = {
  queried_at?: string;
  count?: number;
  policies?: AuditPolicyRow[];
};

function createServiceClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      `Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${envFile}`,
    );
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function projectRefFromUrl(url: string): string {
  return url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '(unknown)';
}

function policyKey(table: string, policy: string): string {
  return `${table}:${policy}`;
}

async function fetchAnonTruePolicies(admin: SupabaseClient): Promise<AuditPolicyRow[]> {
  const { data, error } = await admin.rpc('audit_anon_open_rls_policies');
  expect(error, error?.message).toBeNull();

  const payload = data as AuditResult | null;
  expect(payload).toBeTruthy();
  return payload?.policies ?? [];
}

test('RLS-AUDIT: anon/PUBLIC true-expression policies match explicit allowlist', async () => {
  const admin = createServiceClient();
  const projectRef = projectRefFromUrl(process.env.VITE_SUPABASE_URL ?? '');

  const found = await fetchAnonTruePolicies(admin);
  const foundByKey = new Map(found.map((row) => [policyKey(row.table_name, row.policy_name), row]));

  console.log(`=== RLS policy audit (${envFile}, project ${projectRef}) ===`);
  console.log(`open anon/PUBLIC true policies: ${found.length}`);
  for (const row of found) {
    console.log(
      `  - ${row.table_name}.${row.policy_name} [${row.command}] USING=${row.using_expr ?? 'NULL'} WITH CHECK=${row.with_check_expr ?? 'NULL'}`,
    );
  }

  const allowlistKeys = new Set(
    ALLOWED_ANON_TRUE_POLICIES.map((entry) => policyKey(entry.table, entry.policy)),
  );

  const unexpected = found.filter(
    (row) => !allowlistKeys.has(policyKey(row.table_name, row.policy_name)),
  );
  expect(
    unexpected,
    `Unexpected open anon/PUBLIC policies (not in allowlist): ${unexpected
      .map((row) => `${row.table_name}.${row.policy_name} [${row.command}]`)
      .join(', ') || '(none)'}`,
  ).toEqual([]);

  const missing: string[] = [];
  const wrongCommand: string[] = [];

  for (const entry of ALLOWED_ANON_TRUE_POLICIES) {
    const key = policyKey(entry.table, entry.policy);
    const row = foundByKey.get(key);
    if (!row) {
      missing.push(key);
      continue;
    }
    if (row.command !== entry.command) {
      wrongCommand.push(`${key} is ${row.command}, expected ${entry.command}`);
    }
  }

  expect(
    missing,
    `Allowlisted policies missing from database: ${missing.join(', ') || '(none)'}`,
  ).toEqual([]);
  expect(
    wrongCommand,
    `Allowlisted policies widened beyond SELECT: ${wrongCommand.join('; ') || '(none)'}`,
  ).toEqual([]);

  expect(found.length).toBe(ALLOWED_ANON_TRUE_POLICIES.length);
  console.log('rls_policy_audit_status: PASS');
});
