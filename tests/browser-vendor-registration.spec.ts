import { test, expect } from '@playwright/test';
import { APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestData,
  cleanupTestVendors,
  deleteVendorRegistrationArtifacts,
  getFirstActiveCategory,
  getActiveCategoryByLabel,
  TEST_ADMIN_PHONE,
  TEST_SESSION,
} from './helpers/setup';

async function cleanupVendorReferralArtifacts(
  refereeVendorId: string,
  referrerVendorId: string,
  referrerPhone: string,
) {
  const { data: refs } = await supabase
    .from('referrals')
    .select('id')
    .eq('referee_id', refereeVendorId);
  const refIds = (refs ?? []).map((r) => r.id);
  if (refIds.length > 0) {
    await supabaseAdmin.from('vendor_credits').delete().in('referral_id', refIds);
    await supabase.from('referrals').delete().in('id', refIds);
  }
  await deleteVendorRegistrationArtifacts(refereeVendorId);
  await supabase
    .from('user_notifications')
    .delete()
    .eq('user_phone', referrerPhone)
    .eq('type', 'referral_credit');
  await supabase.from('vendors').delete().eq('id', referrerVendorId);
}

test.beforeAll(async () => {
  await supabase
    .from('app_config')
    .upsert({ key: 'referral_enabled', value: 'true' }, { onConflict: 'key' });
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test('VR-E2E-01: shop vendor registers without GPS as draft via browser form', async ({ page }) => {
  const phone = `99000${Date.now().toString().slice(-5)}`;
  const category = await getFirstActiveCategory();
  const ownerName = 'Browser Reg Owner';
  const shopName = `Browser Reg Shop ${phone.slice(-4)}`;

  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');

  await page.locator('button').filter({ hasText: '🏪 Shop' }).click();
  await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  await page.getByRole('button').filter({ hasText: category.label }).first().click();
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
  await page.getByPlaceholder('name@okbank').fill('browserreg@upi');

  const since = new Date().toISOString();
  await page.getByRole('button', { name: 'Register me' }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id, phone, profile_status')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  expect(vendor?.phone).toBe(phone);
  expect(vendor?.profile_status).toBe('draft');

  const vendorId = vendor!.id;

  const { data: categoryRows, error: categoryError } = await supabaseAdmin
    .from('vendor_categories')
    .select('id')
    .eq('vendor_id', vendorId);
  expect(categoryError).toBeNull();
  expect((categoryRows?.length ?? 0)).toBeGreaterThanOrEqual(1);

  const { data: verificationRows, error: verificationError } = await supabaseAdmin
    .from('vendor_verification')
    .select('id')
    .eq('vendor_id', vendorId);
  expect(verificationError).toBeNull();
  expect(verificationRows?.length).toBe(7);

  await page.waitForTimeout(2000);

  const { data: adminConfig } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_phone')
    .maybeSingle();
  const adminPhone = adminConfig?.value?.trim() || TEST_ADMIN_PHONE;

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('user_notifications')
          .select('route, route_params')
          .eq('user_phone', adminPhone)
          .eq('type', 'new_vendor')
          .gte('created_at', since)
          .limit(1);
        return data?.length ?? 0;
      },
      { timeout: 15000 },
    )
    .toBe(1);

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('route, route_params')
    .eq('user_phone', adminPhone)
    .eq('type', 'new_vendor')
    .gte('created_at', since)
    .limit(1);
  expect(notifications?.[0]?.route).toBe('vendor');
  expect(notifications?.[0]?.route_params).toMatchObject({ vendor_id: vendorId });

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('VR-MULTI-01: registration UI selects 2 categories and persists both in vendor_categories', async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99013${Date.now().toString().slice(-5)}`;
  const ownerName = 'Multi Cat Owner';
  const shopName = `Multi Cat Shop ${phone.slice(-4)}`;

  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');

  await page.locator('button').filter({ hasText: '🏪 Shop' }).first().click();
  await expect(page.getByPlaceholder('Ramesh Tyre Works')).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const categoryChip = (label: string) =>
    page.getByRole('button').filter({ hasText: label }).filter({ hasText: /Help|Delivery|Appointment/ });
  await expect(categoryChip(electrician.label).first()).toBeVisible({ timeout: 15000 });
  await categoryChip(electrician.label).first().click();
  await expect(page.getByText('1/5 selected')).toBeVisible({ timeout: 5000 });
  await categoryChip(plumber.label).first().click();
  await expect(page.getByText('2/5 selected')).toBeVisible({ timeout: 5000 });
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
  await page.getByPlaceholder('name@okbank').fill('multicat@upi');

  await page.getByRole('button', { name: 'Register me' }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  const vendorId = vendor!.id;

  const { data: categoryRows, error: categoryError } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id, is_primary, categories(label)')
    .eq('vendor_id', vendorId)
    .order('is_primary', { ascending: false });
  expect(categoryError).toBeNull();
  expect(categoryRows?.length).toBe(2);

  const labels = (categoryRows ?? []).map((row) => {
    const cat = row.categories;
    return Array.isArray(cat) ? cat[0]?.label : (cat as { label: string } | null)?.label;
  });
  expect(labels).toContain(electrician.label);
  expect(labels).toContain(plumber.label);
  expect(categoryRows?.[0]?.is_primary).toBe(true);
  expect(categoryRows?.[1]?.is_primary).toBe(false);

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('RF-E2E-02: vendor registration with referral code triggers credits and notification', async ({
  page,
}) => {
  const referrerCode = `RE2E${TEST_SESSION.slice(-6).toUpperCase()}`;
  const referrer = await createTestVendor({
    phone: `99011${Date.now().toString().slice(-5)}`,
    is_active: false,
  });
  const { data: referrerWithCode, error: codeError } = await supabaseAdmin
    .from('vendors')
    .update({ referral_code: referrerCode })
    .eq('id', referrer.id)
    .select('id, referral_code')
    .single();
  expect(codeError).toBeNull();
  expect(referrerWithCode?.referral_code).toBe(referrerCode);
  await supabase
    .from('user_notifications')
    .delete()
    .eq('user_phone', referrer.phone)
    .eq('type', 'referral_credit');

  const phone = `99012${Date.now().toString().slice(-5)}`;
  const category = await getFirstActiveCategory();
  const ownerName = 'Referred Reg Owner';
  const shopName = `Referred Shop ${phone.slice(-4)}`;

  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByPlaceholder('e.g. MAT-9973')).toBeVisible({ timeout: 15000 });

  await page.locator('button').filter({ hasText: '🏪 Shop' }).click();
  await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  await page.getByRole('button').filter({ hasText: category.label }).first().click();
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(phone);
  await page.getByPlaceholder('name@okbank').fill('referredreg@upi');
  await page.getByPlaceholder('e.g. MAT-9973').fill(referrerCode);

  const referralEdgeResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/functions/v1/process-vendor-referral') &&
      resp.request().method() === 'POST',
    { timeout: 30000 },
  );

  await page.getByRole('button', { name: 'Register me' }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  const edgeResp = await referralEdgeResponse;
  expect(edgeResp.status()).toBe(200);

  const { data: newVendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  const newVendorId = newVendor!.id;

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('referrals')
          .select('id, referee_type, referrer_vendor_id')
          .eq('referee_id', newVendorId)
          .maybeSingle();
        return data;
      },
      { timeout: 20000 },
    )
    .toMatchObject({
      referee_type: 'vendor',
      referrer_vendor_id: referrer.id,
    });

  const { data: referral } = await supabaseAdmin
    .from('referrals')
    .select('id')
    .eq('referee_id', newVendorId)
    .single();

  const { data: credits } = await supabaseAdmin
    .from('vendor_credits')
    .select('id, disbursement_month')
    .eq('referral_id', referral!.id)
    .eq('vendor_id', referrer.id);
  expect((credits?.length ?? 0)).toBeGreaterThanOrEqual(1);
  expect((credits?.length ?? 0)).toBeLessThanOrEqual(3);

  await page.waitForTimeout(2000);

  const { data: notifications } = await supabaseAdmin
    .from('user_notifications')
    .select('type')
    .eq('user_phone', referrer.phone)
    .eq('type', 'referral_credit')
    .order('created_at', { ascending: false })
    .limit(1);
  expect(notifications?.length).toBe(1);

  await cleanupVendorReferralArtifacts(newVendorId, referrer.id, referrer.phone);
});
