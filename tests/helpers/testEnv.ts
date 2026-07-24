import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let envLoaded = false;
let serviceClient: SupabaseClient | null = null;

/** Same load order as playwright.config.ts — .env.local then .env.{TEST_ENV}. */
export function loadTestEnv(): void {
  if (envLoaded) return;
  dotenv.config({ path: path.join(projectRoot, '.env.local'), override: true });
  const envName = process.env.TEST_ENV || 'test';
  dotenv.config({ path: path.join(projectRoot, `.env.${envName}`), override: true });
  envLoaded = true;
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
