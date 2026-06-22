import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabaseAdmin } from './helpers/setup';

dotenv.config({ path: '.env.test' });

const VENDOR_PHONE = '9111000011';
const CUSTOMER_PHONE = '9111000012';
const OTHER_VENDOR_PHONE = '9111000013';

const VENDOR_OTP = '+919111000011';
const CUSTOMER_OTP = '+919111000012';
const OTHER_VENDOR_OTP = '+919111000013';

const TEST_NOTE = 'phase-c-tier2-rls-test';

const TEST_PHONES = [VENDOR_PHONE, CUSTOMER_PHONE, OTHER_VENDOR_PHONE];
const TEST_OTP_PHONES = [VENDOR_OTP, CUSTOMER_OTP, OTHER_VENDOR_OTP];

function createAnonClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function waitForCapturedOtp(
  admin: SupabaseClient,
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

async function authenticateViaOtp(otpPhone: string): Promise<SupabaseClient> {
  const authClient = createAnonClient();
  const admin = supabaseAdmin;

  await admin.from('_test_otp_capture').delete().eq('phone', otpPhone);

  let signInError: { message: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await authClient.auth.signInWithOtp({ phone: otpPhone });
    signInError = result.error;
    if (!signInError) break;
    if (signInError.message.includes('only request this after')) {
      const match = signInError.message.match(/after (\d+) seconds?/);
      const waitMs = ((match ? Number(match[1]) : 2) + 0.5) * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    break;
  }
  expect(signInError, signInError?.message).toBeNull();

  const capturedOtp = await waitForCapturedOtp(admin, otpPhone);
  const { data, error: verifyError } = await authClient.auth.verifyOtp({
    phone: otpPhone,
    token: capturedOtp,
    type: 'sms',
  });

  expect(verifyError, verifyError?.message).toBeNull();
  expect(data.session).toBeTruthy();

  return authClient;
}

async function ensureVendor(admin: SupabaseClient, phone: string, name: string): Promise<string> {
  const { data: existing, error: existingError } = await admin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.id) return existing.id;

  const { data, error } = await admin
    .from('vendors')
    .insert({
      name,
      shop_name: `${name} Shop`,
      phone,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: true,
      vendor_note: TEST_NOTE,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function seedUsersRows(admin: SupabaseClient) {
  const { error } = await admin.from('users').insert([
    { phone: CUSTOMER_PHONE, total_orders: 1 },
    { phone: OTHER_VENDOR_PHONE, total_orders: 2 },
  ]);
  if (error) throw error;
}

async function seedUserNotifications(admin: SupabaseClient) {
  const { error } = await admin.from('user_notifications').insert([
    {
      user_phone: CUSTOMER_PHONE,
      type: 'order_accepted',
      title: 'Order accepted',
      body: TEST_NOTE,
      route: 'orders',
      route_params: { test: CUSTOMER_PHONE },
    },
    {
      user_phone: OTHER_VENDOR_PHONE,
      type: 'order_accepted',
      title: 'Other notification',
      body: TEST_NOTE,
      route: 'orders',
      route_params: { test: OTHER_VENDOR_PHONE },
    },
  ]);
  if (error) throw error;
}

async function seedVendorReview(admin: SupabaseClient) {
  const vendorId = await ensureVendor(admin, VENDOR_PHONE, 'RLS T2 Vendor');

  const { data: request, error: requestError } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: CUSTOMER_PHONE,
      message: TEST_NOTE,
      status: 'done',
    })
    .select('id')
    .single();
  if (requestError) throw requestError;

  const { error: reviewError } = await admin.from('vendor_reviews').insert({
    vendor_id: vendorId,
    request_id: request.id,
    user_phone: CUSTOMER_PHONE,
    rating: 5,
    service_mode: 'delivery',
    review_text: TEST_NOTE,
  });
  if (reviewError) throw reviewError;

  return { vendorId, requestId: request.id };
}

async function cleanupSeededData() {
  const admin = supabaseAdmin;

  await admin.from('vendor_reviews').delete().eq('review_text', TEST_NOTE);
  await admin.from('user_notifications').delete().eq('body', TEST_NOTE);
  await admin.from('users').delete().in('phone', TEST_PHONES);

  const { data: vendors } = await admin
    .from('vendors')
    .select('id')
    .in('phone', [VENDOR_PHONE, OTHER_VENDOR_PHONE]);
  const vendorIds = vendors?.map((row) => row.id) ?? [];

  if (vendorIds.length > 0) {
    await admin.from('requests').delete().in('vendor_id', vendorIds);
    await admin.from('vendors').delete().in('id', vendorIds);
  }

  await admin.from('_test_otp_capture').delete().in('phone', TEST_OTP_PHONES);
}

test.afterEach(async () => {
  await cleanupSeededData();
});

test('RLS-T2-01: Unauthenticated anon gets zero rows from users table', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await seedUsersRows(admin);

  const { count: adminCount } = await admin
    .from('users')
    .select('*', { count: 'exact', head: true })
    .in('phone', [CUSTOMER_PHONE, OTHER_VENDOR_PHONE]);
  expect(adminCount).toBe(2);

  const { data, error } = await anon.from('users').select('*');
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('RLS-T2-02: Authenticated user sees only their own users row', async () => {
  const admin = supabaseAdmin;
  await seedUsersRows(admin);

  const authClient = await authenticateViaOtp(CUSTOMER_OTP);

  const { data, error } = await authClient.from('users').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  expect(data![0].phone).toBe(CUSTOMER_PHONE);
  expect(data!.some((row) => row.phone === OTHER_VENDOR_PHONE)).toBe(false);
});

test('RLS-T2-03: Unauthenticated anon gets zero rows from user_notifications', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await seedUserNotifications(admin);

  const { count: adminCount } = await admin
    .from('user_notifications')
    .select('*', { count: 'exact', head: true })
    .eq('body', TEST_NOTE);
  expect(adminCount).toBe(2);

  const { data, error } = await anon.from('user_notifications').select('*');
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('RLS-T2-04: Authenticated user sees only their own notifications', async () => {
  const admin = supabaseAdmin;
  await seedUserNotifications(admin);

  const authClient = await authenticateViaOtp(CUSTOMER_OTP);

  const { data, error } = await authClient.from('user_notifications').select('*');
  expect(error).toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  expect(data!.every((row) => row.user_phone === CUSTOMER_PHONE)).toBe(true);
  expect(data!.some((row) => row.user_phone === OTHER_VENDOR_PHONE)).toBe(false);
});

test('RLS-T2-05: vendors table is publicly readable without session', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await ensureVendor(admin, VENDOR_PHONE, 'RLS T2 Public Vendor');

  const { data, error } = await anon
    .from('vendors')
    .select('*')
    .eq('phone', VENDOR_PHONE)
    .maybeSingle();

  expect(error).toBeNull();
  expect(data).toBeTruthy();
  expect(data!.phone).toBe(VENDOR_PHONE);
});

test('RLS-T2-06: vendor_reviews are publicly readable without session', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await seedVendorReview(admin);

  const { data, error } = await anon
    .from('vendor_reviews')
    .select('*')
    .eq('review_text', TEST_NOTE);

  expect(error).toBeNull();
  expect(data!.length).toBe(1);
  expect(data![0].review_text).toBe(TEST_NOTE);
});
