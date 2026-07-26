import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let envLoaded = false;
let serviceClient: SupabaseClient | null = null;

/**
 * Same load order as playwright.config.ts — .env.local then .env.{TEST_ENV}.
 * Preserves PW_APP_URL (set by playwright*.config.ts) so dotenv cannot retarget
 * absolute page.goto helpers to a stale VITE_APP_URL port (e.g. .env.test.prod → :8081
 * while prod-full webServer is on :8082).
 */
export function loadTestEnv(): void {
  if (envLoaded) return;
  // Capture before dotenv: env files (e.g. .env.test.prod) may set TEST_ENV=test
  // and would otherwise cause a second load of .env.test, retargeting away from PROD.
  const requestedEnv = process.env.TEST_ENV || 'test';
  const pinnedAppUrl = (process.env.PW_APP_URL ?? '').trim();
  dotenv.config({ path: path.join(projectRoot, '.env.local'), override: true });
  dotenv.config({ path: path.join(projectRoot, `.env.${requestedEnv}`), override: true });
  if ((process.env.TEST_ENV || 'test') !== requestedEnv) {
    process.env.TEST_ENV = requestedEnv;
    dotenv.config({ path: path.join(projectRoot, `.env.${requestedEnv}`), override: true });
    process.env.TEST_ENV = requestedEnv;
  }
  if (pinnedAppUrl) {
    process.env.PW_APP_URL = pinnedAppUrl;
    process.env.VITE_APP_URL = pinnedAppUrl;
  }
  envLoaded = true;
}

/** App origin for absolute navigations — prefers PW_APP_URL from the active Playwright config. */
export function getAppUrl(): string {
  loadTestEnv();
  const raw = (process.env.PW_APP_URL || process.env.VITE_APP_URL || 'http://localhost:8081').trim();
  return raw.replace(/\/$/, '');
}

export function getSupabaseUrl(): string {
  loadTestEnv();
  const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
  if (!url) throw new Error('VITE_SUPABASE_URL missing from test env');
  return url;
}

export function getAnonKey(): string {
  loadTestEnv();
  const key = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  if (!key) throw new Error('VITE_SUPABASE_ANON_KEY missing from test env');
  return key;
}

export function getServiceRoleKey(): string {
  loadTestEnv();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY missing. Add the TEST project sb_secret_… key to .env.test (Dashboard → Settings → API Keys).',
    );
  }
  if (key.startsWith('sb_publishable_')) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be sb_secret_… or legacy service_role JWT — got publishable key.',
    );
  }
  return key;
}

export function getServiceRoleKeyFormat(): 'sb_secret' | 'legacy_jwt' | 'other' {
  const key = getServiceRoleKey();
  if (key.startsWith('sb_secret_')) return 'sb_secret';
  if (key.startsWith('eyJ')) return 'legacy_jwt';
  return 'other';
}

/** Service-role client for seed/cleanup and Auth Admin (listUsers/createUser). */
export function getServiceRoleClient(): SupabaseClient {
  if (!serviceClient) {
    serviceClient = createClient(getSupabaseUrl(), getServiceRoleKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return serviceClient;
}

/**
 * Auth Admin (`/auth/v1/admin/*`) with sb_secret is intermittently rejected on this
 * project after ES256 signing-key migration ("unrecognized JWT kid <nil> for algorithm ES256").
 * PostgREST with the same key is stable. Retry transient Auth Admin JWT failures.
 */
export function isTransientAuthAdminJwtError(message: string | undefined | null): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('unrecognized jwt kid') ||
    m.includes('token is unverifiable') ||
    (m.includes('invalid jwt') && m.includes('es256'))
  );
}

export async function withAuthAdminRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? 6;
  const delayMs = opts?.delayMs ?? 150;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientAuthAdminJwtError(msg) || i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed after retries`);
}

/** Auth Admin call that returns { error } — retry when error is the transient JWT kid failure. */
export async function withAuthAdminResultRetry<T extends { error: { message: string } | null }>(
  label: string,
  fn: () => Promise<T>,
  opts?: { attempts?: number; delayMs?: number },
): Promise<T> {
  return withAuthAdminRetry(
    label,
    async () => {
      const result = await fn();
      if (result.error && isTransientAuthAdminJwtError(result.error.message)) {
        throw new Error(result.error.message);
      }
      return result;
    },
    opts,
  );
}
