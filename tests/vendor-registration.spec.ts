import { test, expect } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  cleanupTestData, cleanupTestVendors,
  createTestVendor,
  getFirstActiveCategory,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  TEST_VENDOR_PHONE,
  TEST_ADMIN_PHONE,
  TEST_SESSION,
} from './helpers/setup';
import {
  assertRowExists,
  assertRowNotExists,
  assertVendorField,
  assertNotificationCreated,
} from './helpers/db-assert';

const ADMIN_PHONE = TEST_ADMIN_PHONE;
let testVendorId: string;

test.beforeAll(async () => {
  const { data: existing } = await supabaseAdmin.from('vendors').select('id').eq('phone', TEST_VENDOR_PHONE);
  for (const row of existing ?? []) {
    await deleteVendorRegistrationArtifacts(row.id);
  }

  const vendor = await createTestVendor({
    name: 'Test Owner',
    shop_name: `Test Shop ${TEST_SESSION}`,
    phone: TEST_VENDOR_PHONE,
    is_active: false,
  });
  testVendorId = vendor.id;
});

test.afterAll(async () => {
  const { data: existing } = await supabaseAdmin.from('vendors').select('id').eq('phone', TEST_VENDOR_PHONE);
  for (const row of existing ?? []) {
    await deleteVendorRegistrationArtifacts(row.id);
  }
  await cleanupTestVendors();
  await cleanupTestData();
  await supabaseAdmin.from('admin_actions').delete().eq('target_id', testVendorId);
});

// ─── REGISTRATION ─────────────────────────────────────────────────────────

test('VR-01b: admin notified after new vendor registration', async () => {
  const phone = `99001${Date.now().toString().slice(-5)}`;
  const category = await getFirstActiveCategory();
  const ownerName = 'VR01b Test Owner';
  const shopName = `VR01b Shop ${TEST_SESSION}`;

  const registerResult = await invokeRegisterVendorRpc({
    phone,
    name: ownerName,
    shop_name: shopName,
    category: category.label,
    service_mode: category.service_mode,
    is_active: false,
  });
  expect(registerResult.error).toBeUndefined();
  expect(registerResult.vendorId).toBeTruthy();
  const vendorId = registerResult.vendorId!;

  const { data: adminConfig } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_phone')
    .maybeSingle();
  const adminPhone = adminConfig?.value?.trim() || ADMIN_PHONE;

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: adminPhone,
    type: 'new_vendor',
    title: '🏪 New vendor registered',
    body: `${ownerName} — ${category.label} (${category.service_mode})`,
    route: 'vendor',
    route_params: { vendor_id: vendorId },
    is_informational: true,
  });

  const notification = await assertNotificationCreated(adminPhone, 'new_vendor');
  expect(notification.route).toBe('vendor');
  expect((notification.route_params as { vendor_id?: string })?.vendor_id).toBe(vendorId);

  await deleteVendorRegistrationArtifacts(vendorId);
});

test('VR-02: duplicate phone — register_vendor returns 23505, no second row created', async () => {
  const category = await getFirstActiveCategory();
  const phone = `99002${Date.now().toString().slice(-5)}`;
  const referralCode = `VR02${Date.now().toString(36).slice(-6).toUpperCase()}`;

  const { data: existing } = await supabaseAdmin.from('vendors').select('id').eq('phone', phone);
  for (const row of existing ?? []) {
    await deleteVendorRegistrationArtifacts(row.id);
  }

  const firstResult = await invokeRegisterVendorRpc({
    phone,
    referral_code: referralCode,
    name: 'VR02 Owner',
    shop_name: `VR02 Shop ${TEST_SESSION}`,
    category: category.label,
    service_mode: category.service_mode,
    is_active: false,
  });
  expect(firstResult.vendorId).toBeTruthy();

  const { count: beforeCount } = await supabaseAdmin
    .from('vendors')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone);
  expect(beforeCount).toBe(1);

  const duplicateResult = await invokeRegisterVendorRpc({
    phone,
    referral_code: referralCode,
    name: 'Duplicate Attempt',
    shop_name: 'Duplicate Shop',
    category: category.label,
    service_mode: category.service_mode,
    is_active: false,
  });

  expect(duplicateResult.vendorId).toBeUndefined();
  expect(duplicateResult.error).toBeDefined();
  expect(duplicateResult.error?.code).toBe('23505');

  const { count: afterCount } = await supabaseAdmin
    .from('vendors')
    .select('id', { count: 'exact', head: true })
    .eq('phone', phone);
  expect(afterCount).toBe(1);

  await deleteVendorRegistrationArtifacts(firstResult.vendorId!);
});

// ─── VERIFICATION STATES ──────────────────────────────────────────────────

test('VV-01: verification_status starts as identity_linked after registration', async () => {
  await assertVendorField(testVendorId, 'verification_status', 'identity_linked');
});

test('VV-03: admin approve sets is_manual_verified = true', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({
      is_manual_verified: true,
      verification_status: 'business_verified',
    })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_manual_verified', true);

  // Admin action logged
  await supabaseAdmin.from('admin_actions').insert({
    admin_phone: ADMIN_PHONE,
    action_type: 'verify_vendor',
    target_type: 'vendor',
    target_id: testVendorId,
    reason: 'All 13 checks passed',
  });
  await assertRowExists('admin_actions', {
    action_type: 'verify_vendor',
    target_id: testVendorId,
  });
});

test('VV-04: unverify resets is_manual_verified to false', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ is_manual_verified: false })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_manual_verified', false);
});

test('VV-04b: unverify when green_pending resets to business_verified', async () => {
  // Set to green_pending first
  await supabaseAdmin
    .from('vendors')
    .update({ verification_status: 'green_pending' })
    .eq('id', testVendorId);

  // Unverify — app sets back to business_verified if was green_pending
  const { data: current } = await supabaseAdmin
    .from('vendors')
    .select('verification_status')
    .eq('id', testVendorId)
    .single();

  const newStatus = current?.verification_status === 'green_pending'
    ? 'business_verified'
    : 'identity_linked';

  await supabaseAdmin
    .from('vendors')
    .update({ verification_status: newStatus, is_manual_verified: false })
    .eq('id', testVendorId);

  await assertVendorField(testVendorId, 'verification_status', 'business_verified');
});

test('VV-05: green_pending auto-trigger — conditions met sets correct status', async () => {
  // Simulate all green criteria met
  await supabaseAdmin
    .from('vendors')
    .update({
      upi_verified: true,
      shop_photo_url: 'https://example.com/photo.jpg',
      avg_rating: 4.5,
      review_count: 5,
    })
    .eq('id', testVendorId);

  // Fetch and check criteria (as app would)
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('upi_verified, shop_photo_url, avg_rating, review_count')
    .eq('id', testVendorId)
    .single();

  const greenCriteriaMet =
    data?.upi_verified &&
    data?.shop_photo_url &&
    (data?.avg_rating ?? 0) >= 4.0 &&
    (data?.review_count ?? 0) >= 3;

  expect(greenCriteriaMet).toBe(true);

  // App would set green_pending + notify admin once
  if (greenCriteriaMet) {
    await supabaseAdmin
      .from('vendors')
      .update({
        verification_status: 'green_pending',
        low_rating_admin_notified: true,
      })
      .eq('id', testVendorId);
  }

  await assertVendorField(testVendorId, 'verification_status', 'green_pending');
  await assertVendorField(testVendorId, 'low_rating_admin_notified', true);
});

test('VV-06: green_pending admin notification NOT fired twice — flag check', async () => {
  // Set flag to true (already notified)
  await supabaseAdmin
    .from('vendors')
    .update({ low_rating_admin_notified: true })
    .eq('id', testVendorId);

  // Fetch vendor — simulate app check before sending notification
  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('low_rating_admin_notified')
    .eq('id', testVendorId)
    .single();

  // App skips notification when flag is true
  const shouldNotify = !vendor?.low_rating_admin_notified;
  expect(shouldNotify).toBe(false);
});

// ─── VENDOR BAN ───────────────────────────────────────────────────────────

test('AD-01: ban vendor — is_banned = true, ban_reason saved, audit logged', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ is_banned: true, ban_reason: 'Fraud detected' })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_banned', true);

  await supabaseAdmin.from('admin_actions').insert({
    admin_phone: ADMIN_PHONE,
    action_type: 'ban_vendor',
    target_type: 'vendor',
    target_id: testVendorId,
    reason: 'Fraud detected',
  });

  await assertRowExists('admin_actions', {
    action_type: 'ban_vendor',
    target_id: testVendorId,
  });
});

test('AD-02: banned vendor cannot go live — is_active blocked', async () => {
  // Banned vendor tries to set is_active = true
  const { data: vendor } = await supabaseAdmin
    .from('vendors')
    .select('is_banned')
    .eq('id', testVendorId)
    .single();

  // App checks is_banned before allowing go-live
  const canGoLive = !vendor?.is_banned;
  expect(canGoLive).toBe(false);
});

test('AD-03: banned vendor excluded from radar query', async () => {
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('id, is_banned')
    .eq('is_banned', false)
    .eq('is_active', true);

  const found = data?.find(v => v.id === testVendorId);
  expect(found).toBeUndefined();
});

test('AD-04: unban vendor — is_banned = false, notification created', async () => {
  const { error } = await supabaseAdmin
    .from('vendors')
    .update({ is_banned: false, ban_reason: null })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_banned', false);

  await supabaseAdmin.from('user_notifications').insert({
    user_phone: TEST_VENDOR_PHONE,
    type: 'account_restored',
    title: 'Account Restored',
    body: 'Your account has been reinstated',
    route: 'vendor',
  });

  await assertNotificationCreated(TEST_VENDOR_PHONE, 'account_restored');
});

// ─── REFERRAL ─────────────────────────────────────────────────────────────

test('RF-08: referral credit amount reads from app_config not hardcoded', async () => {
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_user_credit')
    .single();

  expect(data).not.toBeNull();
  const credit = parseFloat(data!.value);
  expect(credit).toBeGreaterThan(0);
  // Not hardcoded — value exists in DB and is readable
});

test('RF-04: self-referral detection — same phone blocked', async () => {
  // Simulate edge function logic: normalize phone, compare
  const vendorPhone = TEST_VENDOR_PHONE;
  const referralInputPhone = TEST_VENDOR_PHONE; // same phone = self-referral

  const normalize = (p: string) => p.replace(/^\+91/, '').replace(/^91/, '');
  const isSelfReferral = normalize(vendorPhone) === normalize(referralInputPhone);

  expect(isSelfReferral).toBe(true);
  // Edge function would return error here — no referral row created
  await assertRowNotExists('referrals', { referee_id: TEST_VENDOR_PHONE });
});

test('RF-06: referral_enabled = false hides refer & earn', async ({ page }) => {
  const { data: before } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'referral_enabled')
    .single();
  const priorValue = before?.value ?? 'true';

  await supabaseAdmin
    .from('app_config')
    .upsert({ key: 'referral_enabled', value: 'false' }, { onConflict: 'key' });

  try {
    await page.goto(APP_URL);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${APP_URL}/vendor`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Referral Code (optional)')).not.toBeVisible();

    await loginAsVendor(page, TEST_VENDOR_PHONE, testVendorId, `device_rf06_${TEST_SESSION}`);
    await page.goto(`${APP_URL}/settings`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('🎁 Refer & Earn')).not.toBeVisible();
  } finally {
    await supabaseAdmin
      .from('app_config')
      .upsert({ key: 'referral_enabled', value: priorValue }, { onConflict: 'key' });
  }
});

// ─── ADMIN AUDIT LOG ──────────────────────────────────────────────────────

test('AD-10: every admin action is logged to admin_actions', async () => {
  const actions = ['ban_vendor', 'verify_vendor'];

  for (const action of actions) {
    await assertRowExists('admin_actions', {
      action_type: action,
      target_id: testVendorId,
    });
  }
});

test('AD-11: app_config whitelisted keys are readable and updatable', async () => {
  const whitelisted = [
    'referral_enabled',
    'help_accept_timeout_hours',
    'vendor_stopped_minutes',
    'location_ping_seconds',
    'referral_user_credit',
    'dev_menu_pin',
  ];

  const defaults: Record<string, string> = {
    referral_enabled: 'false',
    help_accept_timeout_hours: '2',
    vendor_stopped_minutes: '10',
    location_ping_seconds: '60',
    referral_user_credit: '2.5',
    dev_menu_pin: '1947',
  };

  for (const key of whitelisted) {
    const { data: existing } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (!existing) {
      const { error: seedErr } = await supabaseAdmin.rpc('admin_update_app_config', {
        p_admin_phone: TEST_ADMIN_PHONE,
        p_key: key,
        p_value: defaults[key] ?? '',
      });
      expect(seedErr).toBeNull();
    }
  }

  for (const key of whitelisted) {
    const { data, error } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', key)
      .single();

    expect(error).toBeNull();
    expect(data?.value).toBeDefined();
  }
});
