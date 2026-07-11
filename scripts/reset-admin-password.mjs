/**
 * One-time admin password reset via Supabase Auth admin API.
 *
 * Usage (env vars only — load via shell export or dotenv from .env.local):
 *   node scripts/reset-admin-password.mjs
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAIL
 *   NEW_ADMIN_PASSWORD
 */
import {
  createServiceSupabaseClient,
  findUserIdByEmail,
  loadAdminScriptEnv,
  missingEnvVars,
  printServiceKeyDiagnostics,
} from './lib/adminScriptCommon.mjs';

loadAdminScriptEnv();

const REQUIRED_ENV = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_EMAIL',
  'NEW_ADMIN_PASSWORD',
];

function resolveConfig() {
  const missing = missingEnvVars(REQUIRED_ENV);
  if (missing.length > 0) {
    console.error('Missing required environment variables:');
    for (const name of missing) {
      console.error(`  - ${name}`);
    }
    return null;
  }

  return {
    url: process.env.SUPABASE_URL.trim(),
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY.trim(),
    email: process.env.ADMIN_EMAIL.trim(),
    password: process.env.NEW_ADMIN_PASSWORD,
  };
}

async function main() {
  const config = resolveConfig();
  if (!config) {
    process.exitCode = 1;
    return;
  }

  const { url, serviceRoleKey, email, password } = config;

  printServiceKeyDiagnostics(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );

  console.log('=== Reset admin password ===');
  console.log(`Target project: ${url}`);
  console.log(`Admin email: ${email}`);
  console.log('');

  const supabase = createServiceSupabaseClient(url, serviceRoleKey);

  const userId = await findUserIdByEmail(supabase, email);
  if (!userId) {
    console.error(`No auth user found for email: ${email}`);
    process.exitCode = 1;
    return;
  }

  const { error } = await supabase.auth.admin.updateUserById(userId, { password });
  if (error) {
    throw new Error(`updateUserById failed: ${error.message}`);
  }

  console.log('');
  console.log('=== Password updated ===');
  console.log(`Project URL:  ${url}`);
  console.log(`Admin email:  ${email}`);
  console.log(`User ID:      ${userId}`);
  console.log('Status:       password updated');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
