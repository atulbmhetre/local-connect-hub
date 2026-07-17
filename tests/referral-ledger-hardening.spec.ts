/**
 * Referral ledger hardening: server-side user credit amount + PVR vendor_id rate limit.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };
const EDGE = 'process-vendor-referral';

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdReferralIds: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '880' | '990'): string {
  phoneSeq += 1;
  const phone = `${prefix}73${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function cleanupRateLimits(identifierType: string, identifier: string) {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', EDGE)
    .eq('identifier_type', identifierType)
    .eq('identifier', identifier);
}

async function seedVendor(phone: string, shop: string) {
  const category = await getActiveCategoryByLabel('Grocery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: `RF ${shop}`,
      shop_name: `!RF-${shop}-${T}`,
      category: category.label,
      service_mode: category.service_mode,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 9999,
      discoverable: true,
      latitude: PUNE.lat,
      longitude: PUNE.lng,
      referral_code: `AASP${phone.slice(-4)}`,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);
  return vendor.id as string;
}

test.afterAll(async () => {
  if (createdReferralIds.length) {
    await supabaseAdmin.from('vendor_credits').delete().in('referral_id', createdReferralIds);
    await supabaseAdmin.from('referrals').delete().in('id', createdReferralIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_credits').delete().eq('vendor_id', id);
    await supabaseAdmin.from('referrals').delete().eq('referrer_vendor_id', id);
    await supabaseAdmin.from('referrals').delete().eq('referee_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
    await supabaseAdmin.from('app_users').delete().in('phone', createdPhones);
  }
});

test('RF-AMT-01 — tampered p_credit_amount is ignored; credit uses app_config referral_user_credit', async () => {
  const referrerPhone = nextPhone('990');
  const userPhone = nextPhone('880');
  const referrerId = await seedVendor(referrerPhone, 'AmtRef');

  const { data: cfg } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_user_credit')
    .maybeSingle();
  const expected = Number(String(cfg?.value ?? '2.5').trim());
  expect(Number.isFinite(expected) && expected > 0).toBe(true);

  const { data: referralId, error } = await supabaseAdmin.rpc('record_user_referral_reward', {
    p_referrer_vendor_id: referrerId,
    p_user_phone: userPhone,
    p_credit_amount: 999.99, // tampered — must be ignored
  });
  expect(error, error?.message).toBeNull();
  expect(referralId).toBeTruthy();
  createdReferralIds.push(referralId as string);

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('amount')
    .eq('referral_id', referralId)
    .eq('vendor_id', referrerId);
  expect(credits).toHaveLength(1);
  expect(Number(credits![0].amount)).toBeCloseTo(expected, 2);
  expect(Number(credits![0].amount)).not.toBeCloseTo(999.99, 2);
});

test('RF-AMT-02 — omitting p_credit_amount still credits config amount', async () => {
  const referrerPhone = nextPhone('990');
  const userPhone = nextPhone('880');
  const referrerId = await seedVendor(referrerPhone, 'AmtOmit');

  const { data: cfg } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_user_credit')
    .maybeSingle();
  const expected = Number(String(cfg?.value ?? '2.5').trim());

  const { data: referralId, error } = await supabaseAdmin.rpc('record_user_referral_reward', {
    p_referrer_vendor_id: referrerId,
    p_user_phone: userPhone,
  });
  expect(error, error?.message).toBeNull();
  createdReferralIds.push(referralId as string);

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('amount')
    .eq('referral_id', referralId);
  expect(credits).toHaveLength(1);
  expect(Number(credits![0].amount)).toBeCloseTo(expected, 2);
});

test('PVR-RL-02 — same new_vendor_id: 5 attempts allowed, 6th rate-limited (vendor_id layer)', async () => {
  const newVendorId = randomUUID();
  const invalidCode = `NOPE${TEST_SESSION}`.toUpperCase();

  await cleanupRateLimits('vendor_id', newVendorId);
  await cleanupRateLimits('ip', 'unknown');

  try {
    for (let i = 0; i < 5; i++) {
      const { data, error } = await supabase.functions.invoke(EDGE, {
        body: { new_vendor_id: newVendorId, referral_code: invalidCode },
      });
      expect(error, error?.message).toBeNull();
      const payload = data as { success?: boolean; error?: string };
      expect(payload?.error ?? '').not.toContain('Too many requests');
      // Invalid code after rate-limit checks pass
      expect(payload?.success).toBe(false);
    }

    const sixth = await supabase.functions.invoke(EDGE, {
      body: { new_vendor_id: newVendorId, referral_code: invalidCode },
    });
    expect(sixth.error, sixth.error?.message).toBeNull();
    const payload = sixth.data as { success?: boolean; error?: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Too many requests');
  } finally {
    await cleanupRateLimits('vendor_id', newVendorId);
    await cleanupRateLimits('ip', 'unknown');
  }
});
