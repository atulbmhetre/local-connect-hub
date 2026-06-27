import { test, expect } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabaseAdmin } from './helpers/setup';

dotenv.config({ path: '.env.test' });

const T = Date.now();
const VENDOR_PHONE = `9111${String(T).slice(-6)}`;
const CUSTOMER_A_PHONE = `9112${String(T).slice(-6)}`;
const CUSTOMER_B_PHONE = `9113${String(T).slice(-6)}`;
const VENDOR_OTP = `+91${VENDOR_PHONE}`;
const CUSTOMER_A_OTP = `+91${CUSTOMER_A_PHONE}`;
const CUSTOMER_B_OTP = `+91${CUSTOMER_B_PHONE}`;

const PRECISE_LAT = 18.50743;
const PRECISE_LNG = 73.80774;

const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

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

async function seedVendor(overrides: Record<string, unknown> = {}) {
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Maps DB Vendor',
      shop_name: `Maps Shop ${T}`,
      phone: VENDOR_PHONE,
      category: 'Grocery',
      service_mode: 'delivery',
      is_active: true,
      profile_status: 'complete',
      latitude: 18.5204,
      longitude: 73.8567,
      ...overrides,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  return data;
}

async function seedRequest(
  vendorId: string,
  userPhone: string,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `maps_db_device_${T}_${userPhone}`,
      message: `MAPS-DB-${T}`,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data;
}

async function cleanupSeededData() {
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', [...createdRequestIds]);
    createdRequestIds.length = 0;
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendors').delete().in('id', [...createdVendorIds]);
    createdVendorIds.length = 0;
  }
  await supabaseAdmin
    .from('_test_otp_capture')
    .delete()
    .in('phone', [VENDOR_OTP, CUSTOMER_A_OTP, CUSTOMER_B_OTP]);
}

test.afterEach(async () => {
  await cleanupSeededData();
});

test('MAPS-DB-01: insert request with customer coords → values persist exactly', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBe(PRECISE_LAT);
  expect(data?.customer_longitude).toBe(PRECISE_LNG);
});

test('MAPS-DB-02: insert request without coords → latitude and longitude are null', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE);

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBeNull();
  expect(data?.customer_longitude).toBeNull();
});

test('MAPS-DB-03: help mode request with coords → stored correctly', async () => {
  const vendor = await seedVendor({ service_mode: 'help' });
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBe(PRECISE_LAT);
  expect(data?.customer_longitude).toBe(PRECISE_LNG);
});

test('MAPS-DB-04: delivery request with coords → vendor can read coords via RLS', async () => {
  const vendor = await seedVendor({ service_mode: 'delivery' });
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const vendorClient = await authenticateViaOtp(VENDOR_OTP);
  const { data, error } = await vendorClient
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .maybeSingle();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBe(PRECISE_LAT);
  expect(data?.customer_longitude).toBe(PRECISE_LNG);
});

test('MAPS-DB-05: customer cannot read another customer coords (RLS isolation)', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const otherCustomerClient = await authenticateViaOtp(CUSTOMER_B_OTP);
  const { data, error } = await otherCustomerClient
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id);

  expect(error).toBeNull();
  expect(data).toEqual([]);
});

test('MAPS-DB-06: update existing request to add coords → update succeeds', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE);

  const { error: updateError } = await supabaseAdmin
    .from('requests')
    .update({
      customer_latitude: PRECISE_LAT,
      customer_longitude: PRECISE_LNG,
    })
    .eq('id', request.id);
  expect(updateError).toBeNull();

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBe(PRECISE_LAT);
  expect(data?.customer_longitude).toBe(PRECISE_LNG);
});

test('MAPS-DB-07: coords stored with full double precision accuracy', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: 18.50743,
    customer_longitude: 73.80774,
  });

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBe(18.50743);
  expect(data?.customer_longitude).toBe(73.80774);
});

test('MAPS-DB-08: customer_latitude null update clears coords', async () => {
  const vendor = await seedVendor();
  const request = await seedRequest(vendor.id, CUSTOMER_A_PHONE, {
    customer_latitude: PRECISE_LAT,
    customer_longitude: PRECISE_LNG,
  });

  const { error: updateError } = await supabaseAdmin
    .from('requests')
    .update({
      customer_latitude: null,
      customer_longitude: null,
    })
    .eq('id', request.id);
  expect(updateError).toBeNull();

  const { data, error } = await supabaseAdmin
    .from('requests')
    .select('customer_latitude, customer_longitude')
    .eq('id', request.id)
    .single();

  expect(error).toBeNull();
  expect(data?.customer_latitude).toBeNull();
  expect(data?.customer_longitude).toBeNull();
});
