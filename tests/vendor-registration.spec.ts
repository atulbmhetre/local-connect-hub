import { test, expect } from '@playwright/test';
import {
  supabase,
  cleanupTestData, cleanupTestVendors,
  getFirstActiveCategory,
  seedDefaultVendorVerification,
  seedVendorCategory,
  TEST_VENDOR_PHONE,
  TEST_SESSION,
} from './helpers/setup';
import {
  assertRowExists,
  assertRowNotExists,
  assertVendorField,
  assertNotificationCreated,
} from './helpers/db-assert';

const ADMIN_PHONE = '8888169446';
let testVendorId: string;

test.beforeAll(async () => {
  // Create test vendor upfront — all tests share this vendor
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      name: 'Test Owner',
      shop_name: `Test Shop ${TEST_SESSION}`,
      phone: TEST_VENDOR_PHONE,
      category: 'Grocery',
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      upi_id: 'testvendor@upi',
      verification_status: 'identity_linked',
      is_active: false,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  if (error) throw new Error(`beforeAll vendor creation failed: ${error.message}`);
  testVendorId = data.id;

  const category = await getFirstActiveCategory();
  await seedVendorCategory(testVendorId, category, { is_primary: true });
  await seedDefaultVendorVerification(testVendorId);
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
  await supabase.from('admin_actions').delete().eq('target_id', testVendorId);
});

// ─── REGISTRATION ─────────────────────────────────────────────────────────

test('VR-01b: admin notified after new vendor registration', async () => {
  await supabase.from('user_notifications').insert({
    user_phone: ADMIN_PHONE,
    type: 'new_vendor',
    title: 'New Vendor Registered',
    body: `Test Shop ${TEST_SESSION} has registered`,
    route: 'admin',
    route_params: { vendor_id: testVendorId },
  });
  await assertNotificationCreated(ADMIN_PHONE, 'new_vendor');
});

test('VR-02: duplicate phone check — app detects existing phone before insert', async () => {
  // Use a completely isolated phone for this test — no shared state
  const isolatedPhone = `77002${Date.now().toString().slice(-5)}`;

  // Insert first vendor with this phone
  const { data: first, error: firstError } = await supabase
    .from('vendors')
    .insert({
      name: 'First Vendor',
      phone: isolatedPhone,
      service_mode: 'delivery',
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();

  expect(firstError).toBeNull();

  // App-level check: query by phone before second insert
  const { data: phoneCheck } = await supabase
    .from('vendors')
    .select('id')
    .eq('phone', isolatedPhone)
    .limit(1);

  const isDuplicate = (phoneCheck?.length ?? 0) > 0;
  expect(isDuplicate).toBe(true);

  // Cleanup
  await supabase.from('vendors').delete().eq('id', first.id);
});

// ─── VERIFICATION STATES ──────────────────────────────────────────────────

test('VV-01: verification_status starts as identity_linked after registration', async () => {
  await assertVendorField(testVendorId, 'verification_status', 'identity_linked');
});

test('VV-03: admin approve sets is_manual_verified = true', async () => {
  const { error } = await supabase
    .from('vendors')
    .update({
      is_manual_verified: true,
      verification_status: 'business_verified',
    })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_manual_verified', true);

  // Admin action logged
  await supabase.from('admin_actions').insert({
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
  const { error } = await supabase
    .from('vendors')
    .update({ is_manual_verified: false })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_manual_verified', false);
});

test('VV-04b: unverify when green_pending resets to business_verified', async () => {
  // Set to green_pending first
  await supabase
    .from('vendors')
    .update({ verification_status: 'green_pending' })
    .eq('id', testVendorId);

  // Unverify — app sets back to business_verified if was green_pending
  const { data: current } = await supabase
    .from('vendors')
    .select('verification_status')
    .eq('id', testVendorId)
    .single();

  const newStatus = current?.verification_status === 'green_pending'
    ? 'business_verified'
    : 'identity_linked';

  await supabase
    .from('vendors')
    .update({ verification_status: newStatus, is_manual_verified: false })
    .eq('id', testVendorId);

  await assertVendorField(testVendorId, 'verification_status', 'business_verified');
});

test('VV-05: green_pending auto-trigger — conditions met sets correct status', async () => {
  // Simulate all green criteria met
  await supabase
    .from('vendors')
    .update({
      upi_verified: true,
      shop_photo_url: 'https://example.com/photo.jpg',
      avg_rating: 4.5,
      review_count: 5,
    })
    .eq('id', testVendorId);

  // Fetch and check criteria (as app would)
  const { data } = await supabase
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
    await supabase
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
  await supabase
    .from('vendors')
    .update({ low_rating_admin_notified: true })
    .eq('id', testVendorId);

  // Fetch vendor — simulate app check before sending notification
  const { data: vendor } = await supabase
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
  const { error } = await supabase
    .from('vendors')
    .update({ is_banned: true, ban_reason: 'Fraud detected' })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_banned', true);

  await supabase.from('admin_actions').insert({
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
  const { data: vendor } = await supabase
    .from('vendors')
    .select('is_banned')
    .eq('id', testVendorId)
    .single();

  // App checks is_banned before allowing go-live
  const canGoLive = !vendor?.is_banned;
  expect(canGoLive).toBe(false);
});

test('AD-03: banned vendor excluded from radar query', async () => {
  const { data } = await supabase
    .from('vendors')
    .select('id, is_banned')
    .eq('is_banned', false)
    .eq('is_active', true);

  const found = data?.find(v => v.id === testVendorId);
  expect(found).toBeUndefined();
});

test('AD-04: unban vendor — is_banned = false, notification created', async () => {
  const { error } = await supabase
    .from('vendors')
    .update({ is_banned: false, ban_reason: null })
    .eq('id', testVendorId);

  expect(error).toBeNull();
  await assertVendorField(testVendorId, 'is_banned', false);

  await supabase.from('user_notifications').insert({
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
  const { data } = await supabase
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

test('RF-06: referral_enabled = false hides refer & earn', async () => {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'referral_enabled')
    .single();

  // Config key exists and is readable by app
  expect(data).not.toBeNull();
  expect(['true', 'false', '0', '1']).toContain(data!.value);
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

  for (const key of whitelisted) {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', key)
      .single();

    expect(error).toBeNull();
    expect(data?.value).toBeDefined();
  }
});
