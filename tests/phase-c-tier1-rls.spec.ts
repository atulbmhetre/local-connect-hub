import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabaseAdmin } from './helpers/setup';

dotenv.config({ path: '.env.test' });

const VENDOR_PHONE = '9111000001';
const CUSTOMER_PHONE = '9111000002';
const OTHER_VENDOR_PHONE = '9111000003';

const VENDOR_OTP = '+919111000001';
const CUSTOMER_OTP = '+919111000002';
const OTHER_VENDOR_OTP = '+919111000003';

const TEST_NOTE = 'phase-c-tier1-rls-test';

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

  const { error: signInError } = await authClient.auth.signInWithOtp({ phone: otpPhone });
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

async function seedKhataLedgerRows(admin: SupabaseClient) {
  const vendor1Id = await ensureVendor(admin, VENDOR_PHONE, 'RLS Vendor 1');
  const vendor3Id = await ensureVendor(admin, OTHER_VENDOR_PHONE, 'RLS Vendor 3');

  const rows = [
    {
      vendor_id: vendor1Id,
      user_phone: CUSTOMER_PHONE,
      total_outstanding: 100,
    },
    {
      vendor_id: vendor3Id,
      user_phone: '9111000099',
      total_outstanding: 200,
    },
    {
      vendor_id: vendor1Id,
      user_phone: OTHER_VENDOR_PHONE,
      total_outstanding: 50,
    },
  ];

  const { error } = await admin.from('khata_ledger').insert(rows);
  if (error) throw error;

  return { vendor1Id, vendor3Id };
}

async function seedOrderBill(admin: SupabaseClient) {
  const vendorId = await ensureVendor(admin, VENDOR_PHONE, 'RLS Vendor 1');

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

  const { error: billError } = await admin.from('order_bills').insert({
    request_id: request.id,
    vendor_id: vendorId,
    user_phone: CUSTOMER_PHONE,
    total_amount: 250,
    payment_mode: 'cash',
    payment_status: 'unpaid',
  });
  if (billError) throw billError;

  return { vendorId, requestId: request.id };
}

async function seedVendorCredit(admin: SupabaseClient) {
  const vendorId = await ensureVendor(admin, VENDOR_PHONE, 'RLS Vendor 1');

  const { data: referral, error: referralError } = await admin
    .from('referrals')
    .insert({
      referrer_vendor_id: vendorId,
      referee_type: 'user',
      referee_id: CUSTOMER_PHONE,
      status: 'active',
      trigger_rule: 'active_once',
      credits_created: true,
    })
    .select('id')
    .single();
  if (referralError) throw referralError;

  const { error: creditError } = await admin.from('vendor_credits').insert({
    vendor_id: vendorId,
    referral_id: referral.id,
    amount: 10,
    disbursement_month: 1,
    disbursed: false,
  });
  if (creditError) throw creditError;

  return { vendorId, referralId: referral.id };
}

async function cleanupSeededData() {
  const admin = supabaseAdmin;
  const testPhones = [VENDOR_PHONE, OTHER_VENDOR_PHONE];

  const { data: vendors } = await admin
    .from('vendors')
    .select('id')
    .in('phone', testPhones);
  const vendorIds = vendors?.map((row) => row.id) ?? [];

  if (vendorIds.length > 0) {
    const { data: referrals } = await admin
      .from('referrals')
      .select('id')
      .in('referrer_vendor_id', vendorIds);
    const referralIds = referrals?.map((row) => row.id) ?? [];

    if (referralIds.length > 0) {
      await admin.from('vendor_credits').delete().in('referral_id', referralIds);
      await admin.from('referrals').delete().in('id', referralIds);
    }

    await admin.from('vendor_credits').delete().in('vendor_id', vendorIds);
    await admin.from('khata_transactions').delete().in('vendor_id', vendorIds);
    await admin.from('khata_ledger').delete().in('vendor_id', vendorIds);
    await admin.from('order_items').delete().in(
      'request_id',
      (
        await admin.from('requests').select('id').in('vendor_id', vendorIds)
      ).data?.map((row) => row.id) ?? [],
    );
    await admin.from('order_bills').delete().in('vendor_id', vendorIds);
    await admin.from('requests').delete().in('vendor_id', vendorIds);
    await admin.from('vendors').delete().in('id', vendorIds);
  }

  await admin.from('khata_ledger').delete().in('user_phone', [CUSTOMER_PHONE, OTHER_VENDOR_PHONE]);
  await admin.from('_test_otp_capture').delete().in('phone', [VENDOR_OTP, CUSTOMER_OTP, OTHER_VENDOR_OTP]);
}

test.afterEach(async () => {
  await cleanupSeededData();
});

test('RLS-T1-01: Unauthenticated anon gets zero rows from khata_ledger', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  const { vendor1Id, vendor3Id } = await seedKhataLedgerRows(admin);

  const { count: adminCount } = await admin
    .from('khata_ledger')
    .select('*', { count: 'exact', head: true })
    .in('vendor_id', [vendor1Id, vendor3Id]);
  expect(adminCount).toBeGreaterThan(0);

  const { data, error } = await anon.from('khata_ledger').select('*');
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('RLS-T1-02: Authenticated vendor sees only their own khata_ledger rows', async () => {
  const admin = supabaseAdmin;
  const { vendor1Id, vendor3Id } = await seedKhataLedgerRows(admin);

  const authClient = await authenticateViaOtp(VENDOR_OTP);

  const { data, error } = await authClient.from('khata_ledger').select('*');
  expect(error).toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  expect(data!.every((row) => row.vendor_id === vendor1Id)).toBe(true);
  expect(data!.some((row) => row.vendor_id === vendor3Id)).toBe(false);
});

test('RLS-T1-03: Authenticated customer sees only their own khata_ledger rows', async () => {
  const admin = supabaseAdmin;
  await seedKhataLedgerRows(admin);

  const authClient = await authenticateViaOtp(CUSTOMER_OTP);

  const { data, error } = await authClient.from('khata_ledger').select('*');
  expect(error).toBeNull();
  expect(data!.length).toBeGreaterThan(0);
  expect(data!.every((row) => row.user_phone === CUSTOMER_PHONE)).toBe(true);
  expect(data!.some((row) => row.user_phone === OTHER_VENDOR_PHONE)).toBe(false);
});

test('RLS-T1-04: Unauthenticated anon gets zero rows from order_bills', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await seedOrderBill(admin);

  const { count: adminCount } = await admin
    .from('order_bills')
    .select('*', { count: 'exact', head: true })
    .eq('user_phone', CUSTOMER_PHONE);
  expect(adminCount).toBeGreaterThan(0);

  const { data, error } = await anon.from('order_bills').select('*');
  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('RLS-T1-05: Unauthenticated anon gets zero rows from vendor_credits', async () => {
  const admin = supabaseAdmin;
  const anon = createAnonClient();

  await seedVendorCredit(admin);

  const { count: adminCount } = await admin
    .from('vendor_credits')
    .select('*', { count: 'exact', head: true });
  expect(adminCount).toBeGreaterThan(0);

  const { data, error } = await anon.from('vendor_credits').select('*');
  expect(error).toBeNull();
  expect(data).toEqual([]);
});
