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

async function enableE2eCameraMock(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ = true;
  });
}

/** Step A: account (name, phone, UPI, base, GPS, selfie, optional referral). */
async function completeWizardStepA(
  page: Page,
  opts: {
    ownerName: string;
    phone: string;
    upi: string;
    base?: 'shop' | 'home' | 'none';
    referralCode?: string;
  },
) {
  const base = opts.base ?? 'shop';
  await page.getByPlaceholder('Ramesh Kumar').fill(opts.ownerName);
  await page.getByPlaceholder('+91 98xxxxxxxx').fill(opts.phone);
  await page.getByPlaceholder('name@okbank').fill(opts.upi);
  const baseLabel =
    base === 'shop' ? /Shop|दुकान/ : base === 'home' ? /Home|घर/ : /No fixed place|fixed/;
  await page.locator('button').filter({ hasText: baseLabel }).first().click();
  if (base !== 'none') {
    await page
      .getByRole('button', {
        name: /📍 Capture Shop Location|📍 दुकान की लोकेशन|📍 दुकानाचे लोकेशन|📍 Capture|Location set/,
      })
      .click();
  } else {
    await page.waitForTimeout(1500);
  }
  await page.getByTestId('reg-selfie-capture').click();
  await expect(page.getByTestId('reg-selfie-capture')).toContainText(/Retake|Re-shoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  if (opts.referralCode) {
    await page.getByPlaceholder('e.g. MAT-9973').fill(opts.referralCode);
  }
  await page.getByRole('button', { name: 'Next' }).click();
}

/** Step B: single business + shop photo → Register. */
async function completeWizardStepB(
  page: Page,
  opts: {
    categoryLabel: string;
    categoryFilter?: RegExp;
    brandName?: string;
    reach?: 'customer' | 'vendor' | 'both';
    modes: Array<'help' | 'delivery' | 'appointment'>;
    pickRadius?: boolean;
  },
) {
  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const chip = opts.categoryFilter
    ? page
        .getByRole('button')
        .filter({ hasText: opts.categoryLabel })
        .filter({ hasText: opts.categoryFilter })
    : page.getByRole('button').filter({ hasText: opts.categoryLabel });
  await expect(chip.first()).toBeVisible({ timeout: 15000 });
  await chip.first().click();
  // Shop base requires a shop/brand name on Step B (shopFieldOk).
  const brand = opts.brandName ?? `Shop ${Date.now().toString().slice(-4)}`;
  await page.getByPlaceholder('Ramesh Tyre Works').fill(brand);
  const reach = opts.reach ?? 'vendor';
  if (reach === 'customer') {
    await page.getByRole('button', { name: /At their place|उनके पास/ }).click();
  } else if (reach === 'both') {
    await page.getByRole('button', { name: /^Both$|दोनों/ }).click();
  } else {
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  }
  const needRadius = opts.pickRadius ?? (reach === 'customer' || reach === 'both');
  if (needRadius) {
    await page.getByRole('button', { name: '15 km' }).click();
  }
  for (const mode of opts.modes) {
    await page.getByTestId(`reg-avail-${mode}`).click();
  }
  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i })).toBeEnabled({
    timeout: 10000,
  });
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i }).click();
}

/** Add a second business from Settings → My Business → BusinessSetupSheet. */
async function addBusinessViaSetupSheet(
  page: Page,
  opts: {
    categoryLabel: string;
    brandName?: string;
    reach?: 'customer' | 'vendor' | 'both';
    modes?: Array<'help' | 'delivery' | 'appointment'>;
  },
) {
  await page.getByTestId('my-business-add-business').click();
  await expect(page.getByText(/Add another business/i).first()).toBeVisible({ timeout: 10000 });

  const chip = page
    .getByRole('button')
    .filter({ hasText: opts.categoryLabel })
    .filter({ hasText: /Help|Delivery|Appointment|Booking/i });
  await expect(chip.first()).toBeVisible({ timeout: 15000 });
  await chip.first().click();

  const reach = opts.reach ?? 'vendor';
  if (reach === 'customer') {
    await page.getByRole('button', { name: /At their place|उनके पास/ }).click();
  } else if (reach === 'both') {
    await page.getByRole('button', { name: /^Both$|दोनों/ }).click();
  } else {
    await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();
  }
  if (reach === 'customer' || reach === 'both') {
    await page.getByRole('button', { name: '15 km' }).click();
  }

  const modes = opts.modes ?? ['help'];
  for (const mode of modes) {
    await page.getByTestId(`add-business-avail-${mode}`).click();
  }

  await page.getByTestId('add-business-shop-photo').click();
  await expect(page.getByTestId('add-business-shop-photo')).toContainText(
    /Re-shoot|Reshoot|Retake|फिर|पुन्हा/i,
    { timeout: 15000 },
  );

  await page.getByTestId('add-business-submit').click();
  await expect(page.getByTestId('my-business-add-business')).toBeVisible({ timeout: 20000 });
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

test('VR-E2E-01: shop vendor registers with GPS via 2-page wizard', async ({ page }) => {
  const phone = `99000${Date.now().toString().slice(-5)}`;
  const category = await getFirstActiveCategory();
  const ownerName = 'Browser Reg Owner';
  const shopName = `Browser Reg Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'browserreg@upi',
  });
  const since = new Date().toISOString();
  await completeWizardStepB(page, {
    categoryLabel: category.label,
    brandName: shopName,
    modes: ['help'],
  });
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
    .select('id, shop_photo_url')
    .eq('vendor_id', vendorId);
  expect(categoryError).toBeNull();
  expect((categoryRows?.length ?? 0)).toBeGreaterThanOrEqual(1);
  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('vendor_categories')
          .select('shop_photo_url')
          .eq('vendor_id', vendorId);
        return data?.[0]?.shop_photo_url ?? null;
      },
      { timeout: 20000 },
    )
    .toBeTruthy();

  const { data: verificationRows, error: verificationError } = await supabaseAdmin
    .from('vendor_verification')
    .select('id, check_type')
    .eq('vendor_id', vendorId);
  expect(verificationError).toBeNull();
  // Wizard now submits photo_selfie via submit_vendor_verification (parity with My Business),
  // so the checklist includes that row in addition to the prior 7 defaults.
  expect(verificationRows?.length).toBe(8);
  expect(verificationRows?.some((r) => r.check_type === 'photo_selfie')).toBe(true);

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
  expect(notifications?.[0]?.route).toBe('settings');
  expect(notifications?.[0]?.route_params).toMatchObject({ vendor_id: vendorId });

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('VR-MULTI-01: register one business then add second via My Business sheet', async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99013${Date.now().toString().slice(-5)}`;
  const ownerName = 'Multi Cat Owner';
  const shopName = `Multi Cat Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'multicat@upi',
  });
  await completeWizardStepB(page, {
    categoryLabel: electrician.label,
    brandName: shopName,
    modes: ['help'],
  });
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: /Complete verification in Settings/i }).click();
  await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('vendor-my-business')).toBeVisible({ timeout: 10000 });

  await addBusinessViaSetupSheet(page, {
    categoryLabel: plumber.label,
    brandName: `Plumber Brand ${phone.slice(-4)}`,
    reach: 'vendor',
    modes: ['help', 'appointment'],
  });

  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .single();
  expect(vendorError).toBeNull();
  const vendorId = vendor!.id;

  await expect
    .poll(
      async () => {
        const { data } = await supabaseAdmin
          .from('vendor_categories')
          .select('id')
          .eq('vendor_id', vendorId);
        return data?.length ?? 0;
      },
      { timeout: 20000 },
    )
    .toBe(2);

  const { data: categoryRows, error: categoryError } = await supabaseAdmin
    .from('vendor_categories')
    .select('id, category_id, is_primary, categories(label)')
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

  const plumberVc = categoryRows!.find((r) => r.category_id === plumber.id)!;
  const { data: plumberModes } = await supabaseAdmin
    .from('vendor_category_modes')
    .select('mode')
    .eq('vendor_category_id', plumberVc.id);
  expect((plumberModes ?? []).map((m) => m.mode).sort()).toEqual(['appointment', 'help']);

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('VR-MULTI-02: register two categories with distinct per-category modes', async ({ page }) => {
  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const phone = `99015${Date.now().toString().slice(-5)}`;
  const ownerName = 'Dual Mode Owner';
  const shopName = `Dual Mode Shop ${phone.slice(-4)}`;

  await mockVendorGeolocation(page);
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'dualmode@upi',
  });

  await page.getByRole('button', { name: 'Browse all categories' }).click();
  const elecChip = page.getByRole('button').filter({ hasText: electrician.label }).first();
  const plumberChip = page.getByRole('button').filter({ hasText: plumber.label }).first();
  await expect(elecChip).toBeVisible({ timeout: 15000 });
  await elecChip.click();
  await plumberChip.click();

  await page.getByPlaceholder('Ramesh Tyre Works').fill(shopName);
  await page.getByRole('button', { name: /At my place|मेरे पास/ }).click();

  // Per-category selectors use category-id prefixes when multiple are selected.
  await page.getByTestId(`reg-avail-${electrician.id}-help`).click();
  await page.getByTestId(`reg-avail-${electrician.id}-delivery`).click();
  await page.getByTestId(`reg-avail-${plumber.id}-appointment`).click();

  await page.getByTestId('reg-shop-photo-capture').click();
  await expect(page.getByTestId('reg-shop-photo-capture')).toContainText(/Re-shoot|Reshoot|फिर|पुन्हा/i, {
    timeout: 15000,
  });
  await page.getByRole('button', { name: /Register me|मुझे रजिस्टर|नोंदणी करा/i }).click();
  await expect(page.getByText('Welcome aboard!')).toBeVisible({ timeout: 20000 });

  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('id')
    .eq('phone', phone)
    .single();
  const vendorId = vendor!.id;

  const { data: vcRows } = await supabaseAdmin
    .from('vendor_categories')
    .select('id, category_id')
    .eq('vendor_id', vendorId);
  expect(vcRows?.length).toBe(2);

  const elecVc = vcRows!.find((r) => r.category_id === electrician.id)!;
  const plumberVc = vcRows!.find((r) => r.category_id === plumber.id)!;
  const { data: elecModes } = await supabaseAdmin
    .from('vendor_category_modes')
    .select('mode')
    .eq('vendor_category_id', elecVc.id);
  const { data: plumberModes } = await supabaseAdmin
    .from('vendor_category_modes')
    .select('mode')
    .eq('vendor_category_id', plumberVc.id);
  expect((elecModes ?? []).map((m) => m.mode).sort()).toEqual(['delivery', 'help']);
  expect((plumberModes ?? []).map((m) => m.mode)).toEqual(['appointment']);

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
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'deliveryshop@upi',
  });
  await completeWizardStepB(page, {
    categoryLabel: deliveryCat.label,
    categoryFilter: /🚚 Delivery/,
    brandName: shopName,
    modes: ['delivery'],
  });
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
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'apptshop@upi',
  });
  await completeWizardStepB(page, {
    categoryLabel: appointmentCat.label,
    categoryFilter: /🗓️ Appointment/,
    brandName: shopName,
    modes: ['appointment'],
  });
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
  await enableE2eCameraMock(page);
  await page.goto(APP_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${APP_URL}/vendor`);

  await completeWizardStepA(page, {
    ownerName,
    phone,
    upi: 'referredreg@upi',
    referralCode: referrerCode,
  });

  const referralEdgeResponse = page.waitForResponse(
    (resp) =>
      resp.url().includes('/functions/v1/process-vendor-referral') &&
      resp.request().method() === 'POST',
    { timeout: 30000 },
  );

  await completeWizardStepB(page, {
    categoryLabel: category.label,
    brandName: shopName,
    modes: ['help'],
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
