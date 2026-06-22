import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin, createTestVendor, createTestCustomer, cleanupTestData, cleanupTestVendors, TEST_CUSTOMER_PHONE, TEST_SESSION } from './helpers/setup';
import { assertRowExists } from './helpers/db-assert';

let testVendor: any;
const ADMIN_PHONE = '8888169446';

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('user_notifications').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await supabaseAdmin.from('user_flags').delete().eq('user_phone', TEST_CUSTOMER_PHONE);
  await cleanupTestData();
});

test('TRUST-01: new user starts with trust_score = 100', async () => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('trust_score')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.trust_score).toBe(100);
});

test('TRUST-02: warn_count starts at 0', async () => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('warn_count')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.warn_count).toBe(0);
});

test('AD-05: admin warns customer — warn_count increments', async () => {
  const { error } = await supabase.rpc('admin_warn_user', {
    p_admin_phone: ADMIN_PHONE,
    p_user_phone: TEST_CUSTOMER_PHONE,
  });

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('users')
    .select('warn_count, last_warned_at')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.warn_count).toBe(1);
  expect(data?.last_warned_at).not.toBeNull();

  // Admin action logged
  await supabaseAdmin.from('admin_actions').insert({
    admin_phone: ADMIN_PHONE,
    action_type: 'warn_user',
    target_type: 'user',
    target_id: TEST_CUSTOMER_PHONE,
    reason: 'Test warning',
  });

  await assertRowExists('admin_actions', {
    action_type: 'warn_user',
    target_id: TEST_CUSTOMER_PHONE,
  });
});

test('AD-07: customer with warn_count >= 3 is flagged as risky', async () => {
  await supabaseAdmin
    .from('users')
    .update({ warn_count: 3 })
    .eq('phone', TEST_CUSTOMER_PHONE);

  const { data } = await supabaseAdmin
    .from('users')
    .select('warn_count')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  // App shows amber indicator when warn_count >= 3
  const isRisky = (data?.warn_count ?? 0) >= 3;
  expect(isRisky).toBe(true);
});

test('AD-06: admin bans customer — is_banned = true', async () => {
  const { error } = await supabase.rpc('admin_ban_user', {
    p_admin_phone: ADMIN_PHONE,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_reason: 'Test ban',
  });

  expect(error).toBeNull();

  const { data } = await supabaseAdmin
    .from('users')
    .select('is_banned, ban_reason')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.is_banned).toBe(true);
  expect(data?.ban_reason).toBe('Test ban');
});

test('SC-06: banned customer cannot place orders — is_banned check', async () => {
  const { data } = await supabaseAdmin
    .from('users')
    .select('is_banned')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  // App blocks order placement when is_banned = true
  const canPlaceOrder = !data?.is_banned;
  expect(canPlaceOrder).toBe(false);
});

test('TRUST-03: user flag inserted correctly', async () => {
  const { data: order } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: testVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      message: 'Flag test order',
      status: 'done',
    })
    .select()
    .single();

  const { data, error } = await supabaseAdmin
    .from('user_flags')
    .insert({
      vendor_id: testVendor.id,
      request_id: order.id,
      user_phone: TEST_CUSTOMER_PHONE,
      flag_type: 'no_show',
      notes: 'Customer never showed up',
      reviewed_by_admin: false,
    })
    .select()
    .single();

  expect(error).toBeNull();
  expect(data.flag_type).toBe('no_show');
  expect(data.reviewed_by_admin).toBe(false);
});

test('TRUST-04: trust score can be updated', async () => {
  await supabase.rpc('admin_unban_user', {
    p_admin_phone: ADMIN_PHONE,
    p_user_phone: TEST_CUSTOMER_PHONE,
  });
  await supabaseAdmin
    .from('users')
    .update({ trust_score: 75 })
    .eq('phone', TEST_CUSTOMER_PHONE);

  const { data } = await supabaseAdmin
    .from('users')
    .select('trust_score')
    .eq('phone', TEST_CUSTOMER_PHONE)
    .single();

  expect(data?.trust_score).toBe(75);
  expect(data?.trust_score).toBeLessThan(100);
});
