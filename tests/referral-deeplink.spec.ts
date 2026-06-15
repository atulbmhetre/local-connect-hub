import { test, expect, type Page } from '@playwright/test';
import { loginAsCustomer, loginAsFreshUser, APP_URL } from './helpers/browser-setup';
import { dismissWelcomeIfVisible, submitPhoneNumber } from './helpers/browser-recovery';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestData,
  cleanupTestVendors,
  getActiveCategoryByServiceMode,
  TEST_SESSION,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_${TEST_SESSION}`;
const TEST_VENDOR_SHOP = `Ref E2E Shop ${TEST_SESSION}`;
let helpCategoryLabel = '';
let testVendor: { id: string; phone: string; shop_name: string };
const TEST_REFERRAL_CODE = `TREF${TEST_SESSION.slice(-6).toUpperCase()}`;

async function openPhoneEntryForTestVendor(page: Page) {
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.goto(`${APP_URL}/radar?q=${encodeURIComponent(helpCategoryLabel)}`);
  await page.waitForLoadState('networkidle');
  await dismissWelcomeIfVisible(page);

  const vendorCard = page
    .getByTestId('radar-vendor-card')
    .filter({ hasText: TEST_VENDOR_SHOP });
  await expect
    .poll(async () => vendorCard.count(), { timeout: 30000 })
    .toBeGreaterThan(0);
  await vendorCard.first().getByRole('button', { name: /Save as My/i }).click();
  await expect(page.getByText('Enter your mobile number')).toBeVisible({ timeout: 10000 });
}

async function cleanupUserReferralArtifacts(refereePhone: string, referrerPhone: string) {
  const { data: refs } = await supabase
    .from('referrals')
    .select('id')
    .eq('referee_id', refereePhone);
  const refIds = (refs ?? []).map((r) => r.id);
  if (refIds.length > 0) {
    await supabaseAdmin.from('vendor_credits').delete().in('referral_id', refIds);
    await supabase.from('referrals').delete().in('id', refIds);
  }
  await supabase.from('app_users').delete().eq('phone', refereePhone);
  await supabase
    .from('user_notifications')
    .delete()
    .eq('user_phone', referrerPhone)
    .eq('type', 'referral_credit');
}

test.beforeAll(async () => {
  await supabase
    .from('app_config')
    .upsert({ key: 'referral_enabled', value: 'true' }, { onConflict: 'key' });

  const helpCategory = await getActiveCategoryByServiceMode('help');
  helpCategoryLabel = helpCategory.label;
  testVendor = await createTestVendor({
    shop_name: TEST_VENDOR_SHOP,
    category: helpCategory.label,
    category_ids: [helpCategory.id],
    category_service_modes: [helpCategory.service_mode],
    service_mode: 'help',
    latitude: 18.5204,
    longitude: 73.8567,
    is_active: true,
    profile_status: 'complete',
  });
  await supabaseAdmin
    .from('vendors')
    .update({ referral_code: TEST_REFERRAL_CODE })
    .eq('id', testVendor.id);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('REF-LINK-01: visiting /r/CODE stores code in localStorage', async ({ page }) => {
  await loginAsFreshUser(page);

  await page.goto(`${APP_URL}/r/${TEST_REFERRAL_CODE}`);
  await page.waitForTimeout(1500);

  const storedCode = await page.evaluate(() =>
    localStorage.getItem('aaspaas:referral_code'),
  );

  expect(storedCode).toBe(TEST_REFERRAL_CODE);
});

test('REF-LINK-02: /r/CODE redirects to home page', async ({ page }) => {
  await loginAsFreshUser(page);

  await page.goto(`${APP_URL}/r/${TEST_REFERRAL_CODE}`);
  await page.waitForTimeout(1500);

  expect(page.url()).toMatch(/localhost:\d+\/?$/);
});

test('REF-LINK-03: code stored uppercased regardless of input case', async ({ page }) => {
  await loginAsFreshUser(page);

  const lowerCode = TEST_REFERRAL_CODE.toLowerCase();
  await page.goto(`${APP_URL}/r/${lowerCode}`);
  await page.waitForTimeout(1500);

  const storedCode = await page.evaluate(() =>
    localStorage.getItem('aaspaas:referral_code'),
  );

  expect(storedCode).toBe(TEST_REFERRAL_CODE.toUpperCase());
});

test('REF-LINK-04: existing user visiting /r/CODE triggers recordUserReferral', async ({ page }) => {
  const customerPhone = `88077${Date.now().toString().slice(-5)}`;
  const deviceId = `device_reflink04_${TEST_SESSION}`;

  await cleanupUserReferralArtifacts(customerPhone, testVendor.phone);
  await loginAsCustomer(page, customerPhone, deviceId);

  const storagePromise = page.waitForFunction(
    (expected) => localStorage.getItem('aaspaas:referral_code') === expected,
    TEST_REFERRAL_CODE,
    { timeout: 15000 },
  );
  const gotoPromise = page.goto(`${APP_URL}/r/${TEST_REFERRAL_CODE}`);
  await Promise.all([gotoPromise, storagePromise]);

  await page.waitForURL(/\//, { timeout: 15000 });

  await expect
    .poll(
      async () => {
        const { data } = await supabase
          .from('referrals')
          .select('id, referee_id, referee_type')
          .eq('referee_id', customerPhone)
          .maybeSingle();
        return data;
      },
      { timeout: 15000 },
    )
    .toMatchObject({
      referee_id: customerPhone,
      referee_type: 'user',
    });

  await cleanupUserReferralArtifacts(customerPhone, testVendor.phone);
});

test('REF-LINK-05: self-referral — vendor visiting own code does not create referral', async ({ page }) => {
  const vendorDigits = testVendor.phone.replace(/\D/g, '').slice(-10);
  const deviceId = `device_selfref_${TEST_SESSION}`;

  await supabase.from('referrals').delete().eq('referee_id', vendorDigits);
  await supabase.from('app_users').delete().eq('phone', vendorDigits);

  const { count: creditsBefore } = await supabaseAdmin
    .from('vendor_credits')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', testVendor.id);

  await page.goto(`${APP_URL}/`);
  await page.waitForLoadState('networkidle');

  const applied = await page.evaluate(
    async ({ phone, deviceId, code }) => {
      localStorage.setItem('aaspaas:referral_code', code);
      const { recordUserReferral } = await import('/src/lib/referral.ts');
      return await recordUserReferral(phone, deviceId);
    },
    { phone: vendorDigits, deviceId, code: TEST_REFERRAL_CODE },
  );

  expect(applied).toBe(false);

  const { data: referrals } = await supabase
    .from('referrals')
    .select('id')
    .eq('referee_id', vendorDigits);
  expect(referrals?.length ?? 0).toBe(0);

  const { count: creditsAfter } = await supabaseAdmin
    .from('vendor_credits')
    .select('id', { count: 'exact', head: true })
    .eq('vendor_id', testVendor.id);
  expect(creditsAfter ?? 0).toBe(creditsBefore ?? 0);
});

test('REF-LINK-06: referral_enabled = false — feature flag readable', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'referral_enabled')
    .single();

  expect(data).not.toBeNull();
  expect(['true', 'false']).toContain(data!.value);
});

test('REF-LINK-07: duplicate referral for same user blocked', async () => {
  const uniquePhone = `77033${Date.now().toString().slice(-5)}`;

  await supabase.from('referrals').insert({
    referrer_vendor_id: testVendor.id,
    referee_id: uniquePhone,
    referee_type: 'user',
    status: 'pending',
  });

  const { error } = await supabase.from('referrals').insert({
    referrer_vendor_id: testVendor.id,
    referee_id: uniquePhone,
    referee_type: 'user',
    status: 'pending',
  });

  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');

  await supabase.from('referrals').delete().eq('referee_id', uniquePhone);
});

test('RF-E2E-01: full user referral flow via deeplink and phone entry', async ({ page }) => {
  const userPhone = `88088${Date.now().toString().slice(-5)}`;
  const deviceId = `device_rfe2e01_${TEST_SESSION}`;

  await cleanupUserReferralArtifacts(userPhone, testVendor.phone);
  await supabase.from('user_notifications').delete().eq('user_phone', testVendor.phone).eq('type', 'referral_credit');

  const { data: creditConfig } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'referral_user_credit')
    .single();
  const expectedCredit = parseFloat(creditConfig?.value ?? '2.5');

  await loginAsFreshUser(page);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
  await page.context().grantPermissions(['geolocation']);
  await page.evaluate(({ deviceId }) => {
    localStorage.setItem('aaspaas:device_id', deviceId);
    localStorage.setItem('aaspaas:welcomed', 'true');
  }, { deviceId });

  await page.goto(`${APP_URL}/r/${TEST_REFERRAL_CODE}`);
  await page.waitForURL(/\//, { timeout: 15000 });

  const storedCode = await page.evaluate(() =>
    localStorage.getItem('aaspaas:referral_code'),
  );
  expect(storedCode).toBe(TEST_REFERRAL_CODE);

  await openPhoneEntryForTestVendor(page);
  await submitPhoneNumber(page, userPhone);

  await expect
    .poll(
      async () => {
        const { data } = await supabase
          .from('referrals')
          .select('id, referee_type')
          .eq('referee_id', userPhone)
          .maybeSingle();
        return data;
      },
      { timeout: 20000 },
    )
    .toMatchObject({
      referee_type: 'user',
    });

  const { data: referral } = await supabase
    .from('referrals')
    .select('id, credits_created')
    .eq('referee_id', userPhone)
    .single();

  await expect
    .poll(
      async () => {
        const { count } = await supabaseAdmin
          .from('vendor_credits')
          .select('id', { count: 'exact', head: true })
          .eq('referral_id', referral!.id)
          .eq('vendor_id', testVendor.id);
        return count ?? 0;
      },
      { timeout: 20000 },
    )
    .toBe(1);

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('amount')
    .eq('referral_id', referral!.id)
    .eq('vendor_id', testVendor.id);
  expect(credits?.length).toBe(1);
  expect(credits![0].amount).toBeCloseTo(expectedCredit, 2);

  await expect
    .poll(
      async () => {
        const { data } = await supabase
          .from('referrals')
          .select('credits_created')
          .eq('id', referral!.id)
          .maybeSingle();
        return data?.credits_created === true;
      },
      { timeout: 15000 },
    )
    .toBe(true);

  await expect
    .poll(
      async () => {
        const { data } = await supabase
          .from('user_notifications')
          .select('type')
          .eq('user_phone', testVendor.phone)
          .eq('type', 'referral_credit')
          .order('created_at', { ascending: false })
          .limit(1);
        return data?.length ?? 0;
      },
      { timeout: 15000 },
    )
    .toBe(1);

  await cleanupUserReferralArtifacts(userPhone, testVendor.phone);
  await supabase.from('user_notifications').delete().eq('user_phone', testVendor.phone).eq('type', 'referral_credit');
});
