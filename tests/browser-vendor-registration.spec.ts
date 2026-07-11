import { test, expect, type Page } from '@playwright/test';
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
  getActiveCategoryByServiceMode,
  TEST_ADMIN_PHONE,
  TEST_SESSION,
} from './helpers/setup';

async function mockVendorGeolocation(page: Page) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
}

async function completeWizardPage1Shop(
  page: Page,
  opts: {
    ownerName: string;
    shopName: string;
    categoryLabel: string;
    categoryFilter?: RegExp;
  },
) {
  await page.getByPlaceholder('Ramesh Kumar').fill(opts.ownerName);
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = opts.categoryFilter
    ? page
        .getByRole('button')
        .filter({ hasText: opts.categoryLabel })
        .filter({ hasText: opts.categoryFilter })
    : page.getByRole('button').filter({ hasText: opts.categoryLabel });
  await expect(chip.first()).toBeVisible({ timeout: 15000 });
  await chip.first().click();
  await page
    .locator('button')
    .filter({ hasText: '🏪' })
    .filter({ hasText: /Shop|दुकान/ })
    .first()
    .click();
  await page.getByPlaceholder('Ramesh Tyre Works').fill(opts.shopName);
  await page.getByRole('button', { name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन/ }).click();
  await expect(page.getByRole('button', { name: 'Next' })).toBeEnabled({ timeout: 10000 });
  await page.getByRole('button', { name: 'Next' }).click();
}

async function completeWizardPage2(
  page: Page,
  opts: {
    reach?: 'customer' | 'vendor' | 'both';
    modes: Array<'help' | 'delivery' | 'appointment'>;
    pickRadius?: boolean;
  },
) {
  const reach = opts.reach ?? 'vendor';
  if (reach === 'customer') {
    await page.getByRole('button', { name: /At their place|उनके पास/ }).click();
  } else if (reach === 'both') {
    await page.getByRole('button', { name: /^Both$|दोनों/ }).click();
  } else {
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  }
  if (opts.pickRadius) {
    await page.getByRole('button', { name: '15 km' }).click();
  }
  for (const mode of opts.modes) {
    const label =
      mode === 'help' ? /Urgent help|तुरंत/ : mode === 'delivery' ? /Delivery|डिलीवरी/ : /Appointments|अपॉइंटमेंट/;
    await page.getByRole('button', { name: label }).click();
  }
  await page.getByRole('button', { name: 'Next' }).click();
}

async function completeWizardPage3(
  page: Page,
  opts: { phone: string; upi: string; referralCode?: string },
) {
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(opts.phone);
  await page.getByPlaceholder('name@okbank').fill(opts.upi);
  if (opts.referralCode) {
    await page.getByPlaceholder('e.g. MAT-9973').fill(opts.referralCode);
  }
  await page.getByRole('button', { name: 'Register me' }).click();
}

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

test('VR-E2E-01: shop vendor registers with GPS via 3-page wizard', async ({ page }) => {
  const phone = `99000${Date.now().toString().slice(-5)}`;
  const category = await getFirstActiveCategory();
  const ownerName = 'Browser Reg Owner';
  const shopName = `Browser Reg Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardPage1Shop(page, {
    ownerName,
    shopName,
    categoryLabel: category.label,
  });
  await completeWizardPage2(page, { modes: ['help'] });
  const since = new Date().toISOString();
  await completeWizardPage3(page, { phone, upi: 'browserreg@upi' });
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id, phone, profile_status, base_type, latitude, longitude')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  expect(vendor?.phone).toBe(phone);
  expect(vendor?.profile_status).toBe('complete');
  expect(vendor?.base_type).toBe('shop');
  expect(vendor?.latitude).not.toBeNull();

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

  await mockVendorGeolocation(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await page.getByPlaceholder('Ramesh Kumar').fill(ownerName);
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const categoryChip = (label: string) =>
    page.getByRole('button').filter({ hasText: label }).filter({ hasText: /Help|Delivery|Appointment/ });
  await expect(categoryChip(electrician.label).first()).toBeVisible({ timeout: 15000 });
  await categoryChip(electrician.label).first().click();
  await expect(page.getByText('1/5 selected')).toBeVisible({ timeout: 5000 });
  await categoryChip(plumber.label).first().click();
  await expect(page.getByText('2/5 selected')).toBeVisible({ timeout: 5000 });
  await page
    .locator('button')
    .filter({ hasText: '🏪' })
    .filter({ hasText: /Shop|दुकान/ })
    .first()
    .click();
  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  await page.getByRole('button', { name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन/ }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await completeWizardPage2(page, { modes: ['help'] });
  await completeWizardPage3(page, { phone, upi: 'multicat@upi' });
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

test('VR-SHOP-DELIVERY-01: shop vendor registers via UI with delivery-mode category', async ({
  page,
}) => {
  const deliveryCat = await getActiveCategoryByServiceMode('delivery');
  const phone = `99014${Date.now().toString().slice(-5)}`;
  const ownerName = 'Delivery Shop Owner';
  const shopName = `Delivery Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardPage1Shop(page, {
    ownerName,
    shopName,
    categoryLabel: deliveryCat.label,
    categoryFilter: /🚚 Delivery/,
  });
  await completeWizardPage2(page, { modes: ['delivery'] });
  await completeWizardPage3(page, { phone, upi: 'deliveryshop@upi' });
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  await expect(page.getByTestId('vendor-status-badge')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('No orders yet!')).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: /Complete verification in Settings/i }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 10000 });
  const myBusiness = page.getByTestId('vendor-my-business');
  await expect(myBusiness.getByText(deliveryCat.label).first()).toBeVisible();
  await expect(myBusiness.getByText('🚚 Delivery').first()).toBeVisible();

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id, vendor_type, service_mode, category')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  expect(vendor?.vendor_type).toBe('shop');
  expect(vendor?.service_mode).toBe('delivery');
  expect(vendor?.category).toBe(deliveryCat.label);

  const vendorId = vendor!.id;
  const { data: categoryRows, error: categoryError } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id, is_primary, service_mode')
    .eq('vendor_id', vendorId);
  expect(categoryError).toBeNull();
  expect(categoryRows?.length).toBe(1);
  expect(categoryRows?.[0]?.category_id).toBe(deliveryCat.id);
  expect(categoryRows?.[0]?.is_primary).toBe(true);
  expect(categoryRows?.[0]?.service_mode).toBe('delivery');

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('VR-SHOP-APPT-01: shop vendor registers via UI with appointment-mode category', async ({
  page,
}) => {
  const appointmentCat = await getActiveCategoryByServiceMode('appointment');
  const phone = `99015${Date.now().toString().slice(-5)}`;
  const ownerName = 'Appt Shop Owner';
  const shopName = `Appt Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardPage1Shop(page, {
    ownerName,
    shopName,
    categoryLabel: appointmentCat.label,
    categoryFilter: /🗓️ Appointment/,
  });
  await completeWizardPage2(page, { modes: ['appointment'] });
  await completeWizardPage3(page, { phone, upi: 'apptshop@upi' });
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  await expect(page.getByTestId('vendor-status-badge')).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('No orders yet!')).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: /Complete verification in Settings/i }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 10000 });
  const myBusiness = page.getByTestId('vendor-my-business');
  await expect(myBusiness.getByText(appointmentCat.label).first()).toBeVisible();
  await expect(myBusiness.getByText('🗓️ Appointment').first()).toBeVisible();

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id, vendor_type, service_mode, category')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  expect(vendor?.vendor_type).toBe('shop');
  expect(vendor?.service_mode).toBe('appointment');
  expect(vendor?.category).toBe(appointmentCat.label);

  const vendorId = vendor!.id;
  const { data: categoryRows, error: categoryError } = await supabaseAdmin
    .from('vendor_categories')
    .select('category_id, is_primary, service_mode')
    .eq('vendor_id', vendorId);
  expect(categoryError).toBeNull();
  expect(categoryRows?.length).toBe(1);
  expect(categoryRows?.[0]?.category_id).toBe(appointmentCat.id);
  expect(categoryRows?.[0]?.is_primary).toBe(true);
  expect(categoryRows?.[0]?.service_mode).toBe('appointment');

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

  await mockVendorGeolocation(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardPage1Shop(page, {
    ownerName,
    shopName,
    categoryLabel: category.label,
  });
  await completeWizardPage2(page, { modes: ['help'] });

  const referralEdgeResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/functions/v1/process-vendor-referral') &&
      resp.request().method() === 'POST',
    { timeout: 30000 },
  );

  await completeWizardPage3(page, {
    phone,
    upi: 'referredreg@upi',
    referralCode: referrerCode,
  });
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
