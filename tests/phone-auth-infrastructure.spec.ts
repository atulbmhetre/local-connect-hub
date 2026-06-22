import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.test' });

const T = Date.now();
/** Unique E.164 test phone — not a real subscriber. */
const TEST_PHONE = `+9188009${String(T).slice(-5)}`;

function createAuthTestClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function createAuthAdminClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, '');
}

async function waitForCapturedOtp(
  admin: ReturnType<typeof createAuthAdminClient>,
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

test('PHONE-AUTH-01 — dormant sms-hook OTP round-trip yields real Supabase session', async () => {
  const authClient = createAuthTestClient();
  const admin = createAuthAdminClient();

  await admin.from('_test_otp_capture').delete().eq('phone', TEST_PHONE);

  const { error: signInError } = await authClient.auth.signInWithOtp({ phone: TEST_PHONE });
  expect(signInError, signInError?.message).toBeNull();

  const capturedOtp = await waitForCapturedOtp(admin, TEST_PHONE);
  expect(capturedOtp).toMatch(/^\d{6}$/);

  const { data: verifyData, error: verifyError } = await authClient.auth.verifyOtp({
    phone: TEST_PHONE,
    token: capturedOtp,
    type: 'sms',
  });

  expect(verifyError, verifyError?.message).toBeNull();
  expect(verifyData.session).toBeTruthy();
  expect(verifyData.session?.access_token?.length).toBeGreaterThan(20);
  expect(phoneDigits(verifyData.user?.phone ?? '')).toBe(phoneDigits(TEST_PHONE));

  await admin.from('_test_otp_capture').delete().eq('phone', TEST_PHONE);
});
