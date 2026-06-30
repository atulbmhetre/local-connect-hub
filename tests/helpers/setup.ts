import type { Page } from '@playwright/test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
dotenv.config({ path: '.env.test' });

const APP_URL = process.env.VITE_APP_URL || 'http://localhost:8080';

export const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!
);

/** Bypass RLS for test seed/cleanup on restricted tables (vendor_categories, vendor_verification). */
export const supabaseAdmin = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY!,
);

export const TEST_SESSION = `test_${Date.now()}`;

export const TEST_VENDOR_PHONE = '9900099001';
export const TEST_CUSTOMER_PHONE = '8800088001';
export const TEST_ADMIN_PHONE = '8888169446';

export type RegisterVendorRpcOptions = {
  name?: string;
  shop_name?: string;
  category?: string;
  phone?: string;
  upi_id?: string;
  service_mode?: string;
  vendor_type?: string;
  vendor_note?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  referral_code?: string;
  profile_status?: 'draft' | 'complete';
  category_ids?: string[];
  category_service_modes?: string[];
  /** Preserved from legacy factory; register_vendor always inserts is_active=false. */
  is_active?: boolean;
};

export async function invokeRegisterVendorRpc(
  opts: RegisterVendorRpcOptions = {},
): Promise<{ vendorId?: string; error?: { code?: string; message: string } }> {
  const categoryRow = await getFirstActiveCategory();
  const categoryIds = opts.category_ids ?? [categoryRow.id];
  const serviceModes = opts.category_service_modes ?? [categoryRow.service_mode];
  const phone = opts.phone ?? TEST_VENDOR_PHONE;

  const { data, error } = await supabase.rpc('register_vendor', {
    p_name: opts.name ?? `Test Vendor ${TEST_SESSION}`,
    p_shop_name: opts.shop_name ?? `Test Shop ${TEST_SESSION}`,
    p_category: opts.category ?? categoryRow.label,
    p_phone: phone,
    p_upi_id: opts.upi_id ?? 'testvendor@upi',
    p_service_mode: opts.service_mode ?? categoryRow.service_mode,
    p_vendor_type: opts.vendor_type ?? 'shop',
    p_vendor_note: opts.vendor_note ?? `test_session:${TEST_SESSION}`,
    p_latitude: opts.latitude ?? 18.5204,
    p_longitude: opts.longitude ?? 73.8567,
    p_referral_code:
      opts.referral_code ??
      `T${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase(),
    p_profile_status: opts.profile_status ?? 'complete',
    p_category_ids: categoryIds,
    p_category_service_modes: serviceModes,
  });

  if (error) {
    return { error: { code: error.code, message: error.message } };
  }
  return { vendorId: data as string };
}

export async function createTestVendor(opts: RegisterVendorRpcOptions = {}) {
  const result = await invokeRegisterVendorRpc(opts);
  if (result.error) throw new Error(result.error.message);

  const vendorId = result.vendorId!;
  if (opts.is_active !== false) {
    await supabaseAdmin
      .from('vendors')
      .update({ is_active: opts.is_active ?? true })
      .eq('id', vendorId);
  }

  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('id', vendorId)
    .single();
  if (error) throw error;
  return data;
}

export async function deleteVendorRegistrationArtifacts(vendorId: string) {
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendorId);
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .contains('route_params', { vendor_id: vendorId });
  await supabaseAdmin.from('vendors').delete().eq('id', vendorId);
}

export async function getActiveCategoryByServiceMode(serviceMode: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, emoji, service_mode')
    .eq('is_active', true)
    .eq('service_mode', serviceMode)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No active category found for service_mode: ${serviceMode}`);
  return data;
}

export async function getFirstActiveCategory() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

export async function getActiveCategoryByLabel(label: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .ilike('label', label)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: inactive } = await supabaseAdmin
    .from('categories')
    .select('id, label, service_mode')
    .ilike('label', label)
    .limit(1)
    .maybeSingle();
  if (inactive) {
    const { error: activateError } = await supabaseAdmin
      .from('categories')
      .update({ is_active: true, status: 'active' })
      .eq('id', inactive.id);
    if (activateError) throw activateError;
    return inactive;
  }

  const { data: created, error: insertError } = await supabaseAdmin
    .from('categories')
    .insert({
      label,
      emoji: '🛒',
      service_mode: 'delivery',
      is_active: true,
      status: 'active',
      sort_order: 999,
      pending_review: false,
    })
    .select('id, label, service_mode')
    .single();
  if (insertError) throw insertError;
  return created;
}

export async function getActiveCategories(limit: number) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, emoji, service_mode')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** Minimal order_bills row so delivery/appointment Mark Done can fulfil (check_bill_before_fulfil). */
export async function seedOrderBill(
  requestId: string,
  vendorId: string,
  opts: { user_phone?: string; total_amount?: number } = {},
) {
  const { error } = await supabaseAdmin.from('order_bills').insert({
    request_id: requestId,
    vendor_id: vendorId,
    user_phone: opts.user_phone ?? null,
    total_amount: opts.total_amount ?? 100,
    payment_status: 'unpaid',
  });
  if (error) throw error;
}

export async function seedVendorCategory(
  vendorId: string,
  category: { id: string; service_mode: string },
  opts: { is_primary?: boolean; needs_review?: boolean } = {},
) {
  const { error } = await supabaseAdmin.from('vendor_categories').insert({
    vendor_id: vendorId,
    category_id: category.id,
    is_primary: opts.is_primary ?? true,
    status: 'approved',
    needs_review: opts.needs_review ?? false,
    service_mode: category.service_mode,
  });
  if (error) throw error;
}

export async function seedDefaultVendorVerification(vendorId: string) {
  const { error } = await supabaseAdmin.from('vendor_verification').insert([
    { vendor_id: vendorId, check_type: 'upi_format', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'upi_pennydrop', status: 'dormant', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_shop', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_selfie', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'gps', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'admin_check', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'aadhaar_digilocker', status: 'dormant', checked_by: 'system', is_latest: true },
  ]);
  if (error) throw error;
}

export async function seedBronzeVendorVerification(vendorId: string) {
  const { error } = await supabaseAdmin.from('vendor_verification').insert([
    { vendor_id: vendorId, check_type: 'upi_format', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'upi_pennydrop', status: 'dormant', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_shop', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_selfie', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'gps', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'admin_check', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'aadhaar_digilocker', status: 'dormant', checked_by: 'system', is_latest: true },
  ]);
  if (error) throw error;
}

export async function createTestCustomer(phone = TEST_CUSTOMER_PHONE) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .insert({ phone })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Delete test vendors (phone 99000* or name Test*) and dependent rows in FK-safe order. */
export async function cleanupTestVendors() {
  const [{ data: byPhone }, { data: byName }] = await Promise.all([
    supabase.from('vendors').select('id').like('phone', '99000%'),
    supabase.from('vendors').select('id').like('name', 'Test%'),
  ]);

  const vendorIds = [
    ...new Set([...(byPhone ?? []), ...(byName ?? [])].map((row) => row.id)),
  ];

  if (vendorIds.length > 0) {
    await supabaseAdmin
      .from('categories')
      .update({ suggested_by_vendor_id: null })
      .in('suggested_by_vendor_id', vendorIds);
    await supabaseAdmin
      .from('app_users')
      .update({ referred_by_vendor_id: null })
      .in('referred_by_vendor_id', vendorIds);
    await supabaseAdmin
      .from('feed_replies')
      .update({ suggested_vendor_id: null })
      .in('suggested_vendor_id', vendorIds);

    await supabaseAdmin.from('vendor_credits').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('referrals').delete().in('referrer_vendor_id', vendorIds);
    await supabaseAdmin.from('referrals').delete().like('referee_id', '99000%');

    const { data: requestRows } = await supabase
      .from('requests')
      .select('id')
      .in('vendor_id', vendorIds);
    const requestIds = requestRows?.map((r) => r.id) ?? [];
    if (requestIds.length > 0) {
      await supabaseAdmin.from('order_items').delete().in('request_id', requestIds);
    }
    await supabaseAdmin.from('requests').delete().in('vendor_id', vendorIds);

    await supabaseAdmin.from('saved_vendors').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('vendor_reviews').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('order_bills').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('khata_transactions').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('khata_ledger').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('user_flags').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('vendor_menu_items').delete().in('vendor_id', vendorIds);

    const { data: postRows } = await supabase
      .from('feed_posts')
      .select('id')
      .in('vendor_id', vendorIds);
    const postIds = postRows?.map((p) => p.id) ?? [];
    if (postIds.length > 0) {
      await supabaseAdmin.from('feed_flags').delete().in('post_id', postIds);
      await supabaseAdmin.from('feed_replies').delete().in('post_id', postIds);
    }
    await supabaseAdmin.from('feed_posts').delete().in('vendor_id', vendorIds);

    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('vendor_verification').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', vendorIds);
  } else {
    await supabaseAdmin.from('referrals').delete().like('referee_id', '99000%');
  }
}

export async function cleanupTestData(customerPhone?: string) {
  if (customerPhone) {
    const requestIds =
      (await supabase.from('requests').select('id').eq('user_phone', customerPhone)).data?.map(
        (r) => r.id,
      ) ?? [];
    await supabaseAdmin.from('vendor_reviews').delete().eq('user_phone', customerPhone);
    if (requestIds.length > 0) {
      await supabaseAdmin.from('order_items').delete().in('request_id', requestIds);
      await supabaseAdmin.from('order_bills').delete().in('request_id', requestIds);
    }
    await supabaseAdmin.from('khata_transactions').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('khata_ledger').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', customerPhone);
    await supabaseAdmin.from('referrals').delete().eq('referee_id', customerPhone);
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
    await supabaseAdmin.from('user_addresses').delete().eq('user_phone', customerPhone);
    return;
  }

  // Delete in FK-safe order (legacy wildcard cleanup for 88000* test phones)
  await supabaseAdmin.from('vendor_reviews').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('order_items').delete().in(
    'request_id',
    (await supabase.from('requests').select('id').like('user_phone', '88000%')).data?.map(r => r.id) ?? []
  );
  await supabaseAdmin.from('order_bills').delete().in(
    'request_id',
    (await supabase.from('requests').select('id').like('user_phone', '88000%')).data?.map(r => r.id) ?? []
  );
  await supabaseAdmin.from('khata_transactions').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('khata_ledger').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('user_notifications').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('user_notifications').delete().like('user_phone', '99000%');
  await supabaseAdmin.from('requests').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('saved_vendors').delete().like('user_phone', '88000%');
  await supabaseAdmin.from('admin_actions').delete().like('target_id', '%test%');
  await supabaseAdmin.from('referrals').delete().like('referee_id', '88000%');
  await supabaseAdmin.from('users').delete().like('phone', '88000%');
}

function supabaseAuthStorageKey(): string | null {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const ref = url.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
  return ref ? `sb-${ref}-auth-token` : null;
}

const SESSION_CACHE_FILE = path.join(os.tmpdir(), 'aaspaas-session-cache.json');

type CachedSession = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

function readSessionCache(phone: string): CachedSession | null {
  try {
    const raw = fs.readFileSync(SESSION_CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, CachedSession>;
    const entry = parsed[phone];
    if (!entry) return null;
    if (entry.expires_at > Math.floor(Date.now() / 1000)) return entry;
    return null;
  } catch {
    return null;
  }
}

function writeSessionCache(phone: string, session: CachedSession): void {
  try {
    let data: Record<string, CachedSession> = {};
    try {
      const raw = fs.readFileSync(SESSION_CACHE_FILE, 'utf8');
      data = JSON.parse(raw) as Record<string, CachedSession>;
    } catch {
      // file missing or invalid — start fresh
    }
    data[phone] = session;
    fs.writeFileSync(SESSION_CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch {
    // ignore write failures
  }
}

function testAuthEmail(tenDigitPhone: string): string {
  return `test+91${tenDigitPhone}@aaspaas.invalid`;
}

function testAuthPassword(tenDigitPhone: string): string {
  return `test_pw_${tenDigitPhone}`;
}

function normalizeAuthPhoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

async function findAuthUserIdByPhone(tenDigitPhone: string): Promise<string | null> {
  const authPhone = `91${tenDigitPhone}`;
  let page = 1;
  for (;;) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) return null;
    for (const user of data.users) {
      const digits = normalizeAuthPhoneDigits(user.phone);
      if (digits === authPhone || digits.endsWith(tenDigitPhone)) return user.id;
    }
    if (data.users.length < 200) break;
    page += 1;
    if (page > 50) break;
  }
  return null;
}

/** Ensure auth.users row with phone + test email/password — no SMS OTP. */
async function ensureTestAuthUser(tenDigitPhone: string, logTag: string): Promise<boolean> {
  const email = testAuthEmail(tenDigitPhone);
  const password = testAuthPassword(tenDigitPhone);
  const e164Phone = `+91${tenDigitPhone}`;

  const { error: createError } = await supabaseAdmin.auth.admin.createUser({
    email,
    phone: e164Phone,
    email_confirm: true,
    phone_confirm: true,
    password,
  });
  if (!createError) return true;

  const msg = createError.message.toLowerCase();
  if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
    const userId = await findAuthUserIdByPhone(tenDigitPhone);
    if (!userId) {
      console.warn(`[${logTag}] auth user exists but could not resolve id for ${tenDigitPhone}`);
      return false;
    }
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      email,
      email_confirm: true,
      password,
    });
    if (updateError) {
      console.warn(`[${logTag}] updateUserById failed:`, updateError.message);
      return false;
    }
    return true;
  }

  console.warn(`[${logTag}] admin createUser failed:`, createError.message);
  return false;
}

/** Mint session via service role — bypasses SMS OTP rate limits in browser tests. */
async function mintSessionViaAdmin(
  tenDigitPhone: string,
  logTag: string,
): Promise<CachedSession | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;

  const ready = await ensureTestAuthUser(tenDigitPhone, logTag);
  if (!ready) return null;

  const authClient = createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data, error } = await authClient.auth.signInWithPassword({
    email: testAuthEmail(tenDigitPhone),
    password: testAuthPassword(tenDigitPhone),
  });

  const session = data?.session;
  if (error || !session?.access_token || session.expires_at == null) {
    console.warn(
      `[${logTag}] admin signInWithPassword failed:`,
      error?.message ?? 'missing session',
    );
    return null;
  }

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
  };
}

async function writeSessionToPage(
  page: Page,
  storageKey: string,
  session: CachedSession,
): Promise<void> {
  await page.evaluate(
    async ({ key, payload }) => {
      localStorage.setItem(key, JSON.stringify(payload));
      const { supabase } = await import('/src/lib/supabase.ts');
      const { error } = await supabase.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
      if (error) throw new Error(`setSession failed: ${error.message}`);
    },
    {
      key: storageKey,
      payload: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        token_type: 'bearer',
        expires_at: session.expires_at,
      },
    },
  );
}

const OTP_COUNT_FILE = path.join(os.tmpdir(), 'aaspaas-otp-count.json');
const OTP_COUNT_LOCK_FILE = `${OTP_COUNT_FILE}.lock`;
const OTP_WINDOW_MS = 60_000;
const OTP_MAX_CALLS = 10;
const OTP_RATE_LIMIT_RETRY_MS = 35_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSmsRateLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('sms rate limit') || normalized.includes('rate limit exceeded');
}

async function withOtpCountLock<T>(fn: () => T): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      fs.writeFileSync(OTP_COUNT_LOCK_FILE, String(process.pid), { flag: 'wx' });
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(OTP_COUNT_LOCK_FILE);
        } catch {
          // ignore stale lock cleanup failures
        }
      }
    } catch {
      await sleep(25);
    }
  }
  throw new Error('Failed to acquire OTP count lock');
}

function readRecentOtpTimestamps(): number[] {
  try {
    const raw = fs.readFileSync(OTP_COUNT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { timestamps?: number[] };
    const now = Date.now();
    return (parsed.timestamps ?? []).filter((ts) => now - ts < OTP_WINDOW_MS);
  } catch {
    return [];
  }
}

function writeOtpTimestamps(timestamps: number[]): void {
  fs.writeFileSync(OTP_COUNT_FILE, JSON.stringify({ timestamps }), 'utf8');
}

async function waitForOtpSlot(logTag: string): Promise<void> {
  while (true) {
    const timestamps = await withOtpCountLock(() => readRecentOtpTimestamps());
    if (timestamps.length < OTP_MAX_CALLS) return;

    const oldest = Math.min(...timestamps);
    const waitMs = OTP_WINDOW_MS - (Date.now() - oldest) + 250;
    console.warn(
      `[${logTag}] OTP global limit (${timestamps.length}/${OTP_MAX_CALLS} in 60s), waiting ${Math.ceil(waitMs / 1000)}s`,
    );
    await sleep(Math.max(waitMs, 1000));
  }
}

async function recordOtpCall(): Promise<void> {
  await withOtpCountLock(() => {
    const timestamps = readRecentOtpTimestamps();
    timestamps.push(Date.now());
    writeOtpTimestamps(timestamps);
  });
}

async function signInWithOtpThrottled(
  otpClient: SupabaseClient,
  otpPhone: string,
  logTag: string,
) {
  await waitForOtpSlot(logTag);
  await recordOtpCall();
  let { error } = await otpClient.auth.signInWithOtp({ phone: otpPhone });

  if (error && isSmsRateLimitError(error.message)) {
    console.warn(`[${logTag}] signInWithOtp rate limited, retrying in 35s`);
    await sleep(OTP_RATE_LIMIT_RETRY_MS);
    await waitForOtpSlot(logTag);
    await recordOtpCall();
    ({ error } = await otpClient.auth.signInWithOtp({ phone: otpPhone }));
  }

  return { error };
}

/** Mint a browser Supabase session — admin password sign-in in tests, OTP fallback otherwise. */
export async function mintBrowserSupabaseSession(
  page: Page,
  phone: string,
  logTag: string,
) {
  try {
    const storageKey = supabaseAuthStorageKey();
    if (!storageKey) {
      console.error(`[${logTag}] session mint failed: invalid VITE_SUPABASE_URL`);
      return;
    }

    const cached = readSessionCache(phone);
    if (cached) {
      await writeSessionToPage(page, storageKey, cached);
      return;
    }

    const adminSession = await mintSessionViaAdmin(phone, logTag);
    if (adminSession) {
      writeSessionCache(phone, adminSession);
      await writeSessionToPage(page, storageKey, adminSession);
      return;
    }

    const otpPhone = `91${phone}`;
    const otpClient = createClient(
      process.env.VITE_SUPABASE_URL!,
      process.env.VITE_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    const { error: signInError } = await signInWithOtpThrottled(otpClient, otpPhone, logTag);
    if (signInError) {
      console.error(`[${logTag}] signInWithOtp failed:`, signInError.message);
      return;
    }

    await page.waitForTimeout(1000);

    const { data: otpRow, error: otpReadError } = await supabaseAdmin
      .from('_test_otp_capture')
      .select('otp')
      .eq('phone', `+${otpPhone}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const otp = otpRow?.otp;
    if (otpReadError || !otp) {
      console.error(
        `[${logTag}] OTP capture read failed:`,
        otpReadError?.message ?? 'missing otp',
      );
      return;
    }

    const { data: verifyData, error: verifyError } = await otpClient.auth.verifyOtp({
      phone: otpPhone,
      token: otp,
      type: 'sms',
    });
    const session = verifyData?.session;
    if (verifyError || !session?.access_token || session.expires_at == null) {
      console.error(
        `[${logTag}] verifyOtp failed:`,
        verifyError?.message ?? 'missing session',
      );
      return;
    }

    writeSessionCache(phone, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    });

    await writeSessionToPage(page, storageKey, {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
    });
  } catch (err) {
    console.error(`[${logTag}] session mint failed:`, err);
  }
}

/** Browser login helper — localStorage identity plus Phase D Supabase session. */
export async function loginAsCustomer(page: Page, phone: string, deviceId: string) {
  await page.goto(APP_URL);
  await page.evaluate(({ phone, deviceId }) => {
    localStorage.setItem('aaspaas:user_phone', phone);
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:role', 'customer');
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { phone, deviceId });

  // Phase D: mint a real Supabase session so Phase C RLS policies work
  await mintBrowserSupabaseSession(page, phone, 'loginAsCustomer');

  await page.waitForTimeout(200);
  await page.reload();
  await page.waitForSelector('[data-testid="home-screen"]', { timeout: 15000 });
}
