import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabaseAdmin } from './helpers/setup';

dotenv.config({ path: '.env.test' });

const PHONE_01 = '+919999000001';
const PHONE_02 = '+919999000002';
const PHONE_03 = '+919999000003';

function createAuthTestClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

async function waitForCapturedOtp(
  admin: typeof supabaseAdmin,
  phone: string,
  timeoutMs = 20000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await admin
      .from('_test_otp_capture')
      .select('otp')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.otp) return data.otp;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`OTP not captured for ${phone} within ${timeoutMs}ms`);
}

test('PHASE-B-01: OTP request creates a capturable OTP', async () => {
  const authClient = createAuthTestClient();
  const admin = supabaseAdmin;

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_01);

  const { error: signInError } = await authClient.auth.signInWithOtp({ phone: PHONE_01 });
  expect(signInError, signInError?.message).toBeNull();

  const { data, error } = await admin
    .from('_test_otp_capture')
    .select('otp')
    .eq('phone', PHONE_01)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  expect(error).toBeNull();
  expect(data).toBeTruthy();
  expect(data!.otp).toMatch(/^\d{6}$/);

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_01);
});

test('PHASE-B-02: Correct OTP establishes a real session', async () => {
  const authClient = createAuthTestClient();
  const admin = supabaseAdmin;

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_02);

  const { error: signInError } = await authClient.auth.signInWithOtp({ phone: PHONE_02 });
  expect(signInError, signInError?.message).toBeNull();

  const capturedOtp = await waitForCapturedOtp(admin, PHONE_02);
  expect(capturedOtp).toMatch(/^\d{6}$/);

  const { data: verifyData, error: verifyError } = await authClient.auth.verifyOtp({
    phone: PHONE_02,
    token: capturedOtp,
    type: 'sms',
  });

  expect(verifyError, verifyError?.message).toBeNull();
  expect(verifyData.session).toBeTruthy();
  expect(phoneDigits(verifyData.user?.phone ?? '')).toBe(phoneDigits(PHONE_02));
  expect(verifyData.session?.access_token?.length).toBeGreaterThan(0);

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_02);
});

test('PHASE-B-03: Wrong OTP is rejected', async () => {
  const authClient = createAuthTestClient();
  const admin = supabaseAdmin;

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_03);

  const { error: signInError } = await authClient.auth.signInWithOtp({ phone: PHONE_03 });
  expect(signInError, signInError?.message).toBeNull();

  const { data: verifyData, error: verifyError } = await authClient.auth.verifyOtp({
    phone: PHONE_03,
    token: '000000',
    type: 'sms',
  });

  expect(verifyError).toBeTruthy();
  expect(verifyData.session).toBeNull();

  await admin.from('_test_otp_capture').delete().eq('phone', PHONE_03);
});
