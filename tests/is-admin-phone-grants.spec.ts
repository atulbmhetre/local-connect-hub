/**
 * is_admin_phone is an oracle for app_config.admin_phone.
 * EXECUTE is service_role only (20260903180001). Anon and authenticated
 * sessions must get permission denied, not a boolean.
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { supabase, supabaseAdmin } from './helpers/setup';
import { getAnonKey, getSupabaseUrl } from './helpers/testEnv';

const T = Date.now();
const DUMMY_PHONE = '0000000000';

test('IAP-01 — anon and authenticated cannot EXECUTE is_admin_phone; service_role can', async () => {
  const { data: anonData, error: anonErr } = await supabase.rpc('is_admin_phone', {
    p_phone: DUMMY_PHONE,
  });
  expect(anonErr, 'anon must not execute is_admin_phone').not.toBeNull();
  expect(anonErr!.code).toBe('42501');
  expect(anonData ?? null).toBeNull();

  const { data: svcData, error: svcErr } = await supabaseAdmin.rpc('is_admin_phone', {
    p_phone: DUMMY_PHONE,
  });
  expect(svcErr, svcErr?.message).toBeNull();
  expect(svcData).toBe(false);

  const email = `iap.nonadmin.${T}@aaspaas.invalid`;
  const password = `iap_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  try {
    const nonAdmin = createClient(getSupabaseUrl(), getAnonKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInErr } = await nonAdmin.auth.signInWithPassword({ email, password });
    expect(signInErr, signInErr?.message).toBeNull();

    const { data: authData, error: authErr } = await nonAdmin.rpc('is_admin_phone', {
      p_phone: DUMMY_PHONE,
    });
    expect(authErr, 'authenticated non-admin must not execute is_admin_phone').not.toBeNull();
    expect(authErr!.code).toBe('42501');
    expect(authData ?? null).toBeNull();
  } finally {
    if (created?.user?.id) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    }
  }
});
