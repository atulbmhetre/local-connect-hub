/**
 * One-time admin bootstrap: create (or resolve) a Supabase Auth user and grant admin_users access.
 *
 * Usage (env vars only — load via shell export or dotenv from .env.local):
 *   node scripts/create-admin-user.mjs
 *
 * Required environment variables:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   ADMIN_EMAIL
 *   ADMIN_PASSWORD
 *
 * Safe to re-run: duplicate auth users are resolved by email; admin_users row is upserted.
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
  'ADMIN_PASSWORD',
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
    password: process.env.ADMIN_PASSWORD,
  };
}

function isDuplicateUserError(error) {
  const msg = (error?.message ?? '').toLowerCase();
  return (
    msg.includes('already') ||
    msg.includes('registered') ||
    msg.includes('exists') ||
    msg.includes('duplicate')
  );
}

async function resolveOrCreateAuthUser(supabase, email, password) {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (!error) {
    if (!data?.user?.id) {
      throw new Error('createUser succeeded but returned no user id');
    }
    console.log('Created new auth user.');
    return { userId: data.user.id, created: true };
  }

  if (!isDuplicateUserError(error)) {
    throw new Error(`createUser failed: ${error.message}`);
  }

  console.log('Auth user already exists — looking up by email.');
  const userId = await findUserIdByEmail(supabase, email);
  if (!userId) {
    throw new Error(`duplicate user reported but could not find ${email} via listUsers`);
  }

  return { userId, created: false };
}

async function grantAdminAccess(supabase, userId) {
  const { error } = await supabase
    .from('admin_users')
    .upsert({ user_id: userId }, { onConflict: 'user_id' });

  if (error) {
    throw new Error(`admin_users upsert failed: ${error.message}`);
  }
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

  console.log('=== Create admin user ===');
  console.log(`Target project: ${url}`);
  console.log(`Admin email: ${email}`);
  console.log('');

  const supabase = createServiceSupabaseClient(url, serviceRoleKey);

  const { userId, created } = await resolveOrCreateAuthUser(supabase, email, password);
  await grantAdminAccess(supabase, userId);

  console.log('');
  console.log('=== Admin access granted ===');
  console.log(`Project URL:  ${url}`);
  console.log(`Admin email:  ${email}`);
  console.log(`User ID:      ${userId}`);
  console.log(`Auth action:  ${created ? 'created new user' : 'reused existing user'}`);
  console.log('');
  console.log('This user_id is now in public.admin_users and can call admin RPCs when signed in.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
