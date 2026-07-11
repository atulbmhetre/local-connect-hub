import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

export function loadAdminScriptEnv() {
  dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
}

export function missingEnvVars(requiredNames) {
  return requiredNames.filter((name) => !String(process.env[name] ?? '').trim());
}

export function printServiceKeyDiagnostics(url, rawKey) {
  console.log('=== Environment diagnostics ===');
  console.log(`SUPABASE_URL: ${url}`);
  console.log(`SUPABASE_SERVICE_ROLE_KEY length: ${rawKey.length}`);
  console.log(
    `SUPABASE_SERVICE_ROLE_KEY has leading/trailing whitespace: ${rawKey !== rawKey.trim()}`,
  );

  try {
    const token = rawKey.trim();
    const parts = token.split('.');
    if (parts.length < 2) {
      throw new Error('not a JWT');
    }
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
    );
    const role = payload.role;
    if (typeof role === 'string' && role.length > 0) {
      console.log(`SUPABASE_SERVICE_ROLE_KEY JWT role: ${role}`);
    } else {
      console.log('SUPABASE_SERVICE_ROLE_KEY JWT role: could not decode — key may be malformed');
    }
  } catch {
    console.log('SUPABASE_SERVICE_ROLE_KEY JWT role: could not decode — key may be malformed');
  }

  console.log('');
}

export function createServiceSupabaseClient(url, serviceRoleKey) {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function findUserIdByEmail(supabase, email) {
  const normalized = email.trim().toLowerCase();
  let page = 1;
  const perPage = 200;

  while (page <= 50) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new Error(`listUsers failed: ${error.message}`);
    }

    const match = data.users.find((user) => user.email?.trim().toLowerCase() === normalized);
    if (match) {
      return match.id;
    }

    if (data.users.length < perPage) {
      break;
    }
    page += 1;
  }

  return null;
}
