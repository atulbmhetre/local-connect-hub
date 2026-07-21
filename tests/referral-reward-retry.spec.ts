/**
 * apply_user_referral: atomic create+reward with retry completion.
 *
 * Covers the create-success / reward-fail trap: previously, if
 * create_referred_user succeeded but record_user_referral_reward failed,
 * a retry saw "user already exists" and returned false — the reward was
 * never retried. apply_user_referral must complete the reward on retry,
 * and must never double-credit.
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();
const PUNE = { lat: 18.5204, lng: 73.8567 };

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
let phoneSeq = 0;

function nextPhone(prefix: '880' | '990'): string {
  phoneSeq += 1;
  const phone = `${prefix}74${String(T + phoneSeq).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(phone: string, shop: string) {
  const category = await getActiveCategoryByLabel('Grocery');
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      phone,
      name: `RR ${shop}`,
      shop_name: `!RR-${shop}-${T}`,
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
    .select('id, referral_code')
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);
  return { id: vendor.id as string, referralCode: vendor.referral_code as string };
}

async function expectedCreditAmount(): Promise<number> {
  const { data: cfg } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_user_credit')
    .maybeSingle();
  const n = Number(String(cfg?.value ?? '2.5').trim());
  return Number.isFinite(n) && n > 0 ? n : 2.5;
}

test.beforeAll(async () => {
  await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'referral_enabled', value: 'true' }, { onConflict: 'key' });
});

test.afterAll(async () => {
  if (createdPhones.length) {
    const { data: refs } = await supabaseAdmin
      .from('referrals')
      .select('id')
      .in('referee_id', createdPhones);
    const refIds = (refs ?? []).map((r) => r.id);
    if (refIds.length) {
      await supabaseAdmin.from('vendor_credits').delete().in('referral_id', refIds);
      await supabaseAdmin.from('referrals').delete().in('id', refIds);
    }
    await supabaseAdmin.from('app_users').delete().in('phone', createdPhones);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_credits').delete().eq('vendor_id', id);
    await supabaseAdmin.from('referrals').delete().eq('referrer_vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
});

test('RF-RETRY-01 — create-success + reward-fail: retry via apply_user_referral completes the reward', async () => {
  const referrerPhone = nextPhone('990');
  const userPhone = nextPhone('880');
  const vendor = await seedVendor(referrerPhone, 'RetryTrap');

  // Simulate the trap state: user creation succeeded (referred_by set) but
  // the reward step never ran — no referrals row, no vendor_credits row.
  const { data: created, error: createError } = await supabase.rpc('create_referred_user', {
    p_phone: userPhone,
    p_device_id: `device_rr01_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
    p_referred_by_vendor_id: vendor.id,
  });
  expect(createError, createError?.message).toBeNull();
  expect(created).toBe(true);

  const { count: preReferrals } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referee_id', userPhone);
  expect(preReferrals ?? 0).toBe(0);

  // Retry (as the app now does) — must complete the reward, not no-op.
  const { data, error } = await supabase.rpc('apply_user_referral', {
    p_phone: userPhone,
    p_device_id: `device_rr01_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(error, error?.message).toBeNull();
  const result = data as { applied: boolean; referral_id?: string; credit_amount?: number };
  expect(result.applied).toBe(true);
  expect(result.referral_id).toBeTruthy();

  const { data: referrals } = await supabaseAdmin
    .from('referrals')
    .select('id, credits_created, referee_type')
    .eq('referee_id', userPhone);
  expect(referrals).toHaveLength(1);
  expect(referrals![0].referee_type).toBe('user');
  expect(referrals![0].credits_created).toBe(true);

  const expected = await expectedCreditAmount();
  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('amount')
    .eq('referral_id', referrals![0].id)
    .eq('vendor_id', vendor.id);
  expect(credits).toHaveLength(1);
  expect(Number(credits![0].amount)).toBeCloseTo(expected, 2);
});

test('RF-RETRY-02 — second retry after reward completed is a no-op (no double credit)', async () => {
  const referrerPhone = nextPhone('990');
  const userPhone = nextPhone('880');
  const vendor = await seedVendor(referrerPhone, 'RetryDupe');

  const first = await supabase.rpc('apply_user_referral', {
    p_phone: userPhone,
    p_device_id: `device_rr02_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(first.error, first.error?.message).toBeNull();
  expect((first.data as { applied: boolean }).applied).toBe(true);

  const second = await supabase.rpc('apply_user_referral', {
    p_phone: userPhone,
    p_device_id: `device_rr02_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(second.error, second.error?.message).toBeNull();
  const result = second.data as { applied: boolean; reason?: string };
  expect(result.applied).toBe(false);
  expect(result.reason).toBe('already_rewarded');

  const { data: referrals } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .eq('referee_id', userPhone);
  expect(referrals).toHaveLength(1);

  const { count: creditCount } = await supabaseAdmin
    .from('vendor_credits')
    .select('id', { count: 'exact', head: true })
    .eq('referral_id', referrals![0].id);
  expect(creditCount ?? 0).toBe(1);
});

test('RF-RETRY-03 — fresh user: single call creates user AND records reward atomically', async () => {
  const referrerPhone = nextPhone('990');
  const userPhone = nextPhone('880');
  const vendor = await seedVendor(referrerPhone, 'RetryFresh');

  const { data, error } = await supabase.rpc('apply_user_referral', {
    p_phone: userPhone,
    p_device_id: `device_rr03_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(error, error?.message).toBeNull();
  const result = data as { applied: boolean; vendor_id?: string; vendor_lang?: string };
  expect(result.applied).toBe(true);
  expect(result.vendor_id).toBe(vendor.id);
  // vendor_lang resolves from the VENDOR's app_users.lang (defaults en).
  expect(['en', 'hi', 'mr']).toContain(result.vendor_lang);

  const { data: appUser } = await supabaseAdmin
    .from('app_users')
    .select('phone, referred_by_vendor_id')
    .eq('phone', userPhone)
    .maybeSingle();
  expect(appUser?.referred_by_vendor_id).toBe(vendor.id);

  const { data: referrals } = await supabaseAdmin
    .from('referrals')
    .select('id, credits_created')
    .eq('referee_id', userPhone);
  expect(referrals).toHaveLength(1);
  expect(referrals![0].credits_created).toBe(true);
});

test('RF-RETRY-04 — self-referral and existing non-referred user are refused', async () => {
  const referrerPhone = nextPhone('990');
  const vendor = await seedVendor(referrerPhone, 'RetryGuard');

  // Self-referral: vendor's own phone.
  const self = await supabase.rpc('apply_user_referral', {
    p_phone: referrerPhone,
    p_device_id: `device_rr04_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(self.error, self.error?.message).toBeNull();
  expect(self.data as object).toMatchObject({ applied: false, reason: 'self_referral' });

  // Existing user who was NOT referred by this vendor.
  const organicPhone = nextPhone('880');
  await supabaseAdmin
    .from('app_users')
    .insert({ phone: organicPhone, device_id: `device_rr04b_${TEST_SESSION}` });

  const organic = await supabase.rpc('apply_user_referral', {
    p_phone: organicPhone,
    p_device_id: `device_rr04b_${TEST_SESSION}`,
    p_referral_code: vendor.referralCode,
  });
  expect(organic.error, organic.error?.message).toBeNull();
  expect(organic.data as object).toMatchObject({ applied: false, reason: 'user_exists' });

  const { count } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('referrer_vendor_id', vendor.id);
  expect(count ?? 0).toBe(0);
});
