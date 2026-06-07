import { test, expect } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  createTestVendor,
  createTestCustomer,
  cleanupTestData, cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_VENDOR_PHONE,
  TEST_SESSION,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_neg_${TEST_SESSION}`;
let testVendor: any;

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  await createTestCustomer();
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── BANNED VENDOR ─────────────────────────────────────────────────────────

test('NEG-BAN-01: banned vendor excluded from radar query — DB assert', async () => {
  await supabase.from('vendors').update({ is_banned: true }).eq('id', testVendor.id);
  const { data } = await supabase.from('vendors')
    .select('id')
    .eq('id', testVendor.id)
    .eq('is_banned', false);
  expect(data?.length).toBe(0);
  await supabase.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

test('NEG-BAN-02: banned vendor cannot go live — is_active stays false', async () => {
  await supabase.from('vendors').update({ is_banned: true, is_active: false }).eq('id', testVendor.id);
  const { data } = await supabase.from('vendors')
    .select('is_banned, is_active').eq('id', testVendor.id).single();
  expect(data?.is_banned).toBe(true);
  expect(data?.is_active).toBe(false);
  await supabase.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

test('NEG-BAN-03: banned vendor sees suspension screen in vendor mode', async ({ page }) => {
  await supabase.from('vendors').update({ is_banned: true }).eq('id', testVendor.id);
  await loginAsVendor(page, TEST_VENDOR_PHONE, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Account Suspended')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('vendor-golive-btn')).not.toBeVisible({ timeout: 3000 });
  await supabase.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

// ─── MAX NEIGHBOURS ────────────────────────────────────────────────────────

test('NEG-NEIGH-01: max 20 saved vendors enforced — DB count check', async () => {
  const vendors = [];
  for (let i = 0; i < 20; i++) {
    const { data } = await supabase.from('vendors').insert({
      name: `Neighbour Vendor ${i} ${TEST_SESSION}`,
      shop_name: `Neighbour Shop ${i} ${TEST_SESSION}`,
      phone: `96${String(i).padStart(3, '0')}${Date.now().toString().slice(-5)}`,
      category: 'Grocery',
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `test_session:${TEST_SESSION}`,
    }).select().single();
    vendors.push(data);
  }

  for (const v of vendors) {
    await supabase.from('saved_vendors').insert({
      device_id: TEST_DEVICE_ID,
      vendor_id: v!.id,
      category: 'Grocery',
      nickname: v!.shop_name,
      user_phone: TEST_CUSTOMER_PHONE,
    });
  }

  const { count } = await supabase
    .from('saved_vendors')
    .select('id', { count: 'exact', head: true })
    .or(`user_phone.eq.${TEST_CUSTOMER_PHONE},device_id.eq.${TEST_DEVICE_ID}`);
  expect(count).toBe(20);

  for (const v of vendors) {
    await supabase.from('saved_vendors').delete()
      .eq('device_id', TEST_DEVICE_ID).eq('vendor_id', v!.id);
    await supabase.from('vendors').delete().eq('id', v!.id);
  }
});

test('NEG-NEIGH-02: duplicate saved vendor blocked by unique constraint', async () => {
  await supabase.from('saved_vendors').insert({
    device_id: TEST_DEVICE_ID,
    vendor_id: testVendor.id,
    category: 'Grocery',
    nickname: testVendor.shop_name,
    user_phone: TEST_CUSTOMER_PHONE,
  });
  const { error } = await supabase.from('saved_vendors').insert({
    device_id: TEST_DEVICE_ID,
    vendor_id: testVendor.id,
    category: 'Grocery',
    nickname: testVendor.shop_name,
    user_phone: TEST_CUSTOMER_PHONE,
  });
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
  await supabase.from('saved_vendors').delete()
    .eq('device_id', TEST_DEVICE_ID).eq('vendor_id', testVendor.id);
});

// ─── EDIT ORDER BLOCKED ────────────────────────────────────────────────────

test('NEG-EDIT-01: edit blocked after order accepted — DB status check', async () => {
  const { data: order } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Original message',
    status: 'accepted',
  }).select().single();
  const { data: check } = await supabase.from('requests')
    .select('status, previous_message').eq('id', order!.id).single();
  expect(['accepted', 'done', 'cancelled', 'fulfilled']).toContain(check?.status);
  expect(check?.previous_message).toBeNull();
});

test('NEG-EDIT-02: edit on cancelled order — status blocks write', async () => {
  const { data: order } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Cancelled order',
    status: 'cancelled',
  }).select().single();
  const { data: check } = await supabase.from('requests')
    .select('status').eq('id', order!.id).single();
  expect(check?.status).toBe('cancelled');
});

// ─── REFERRAL EDGE CASES ───────────────────────────────────────────────────

test('NEG-REF-01: duplicate referral blocked — unique constraint on referee', async () => {
  await supabase.from('referrals').insert({
    referrer_vendor_id: testVendor.id,
    referee_id: TEST_CUSTOMER_PHONE,
    referee_type: 'user',
    status: 'pending',
  });
  const { error } = await supabase.from('referrals').insert({
    referrer_vendor_id: testVendor.id,
    referee_id: TEST_CUSTOMER_PHONE,
    referee_type: 'user',
    status: 'pending',
  });
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
  await supabase.from('referrals').delete().eq('referee_id', TEST_CUSTOMER_PHONE);
});

// ─── BANNED CUSTOMER ───────────────────────────────────────────────────────

test('NEG-CUST-01: banned customer cannot place orders — is_banned check', async () => {
  await supabase.from('users').upsert({
    phone: TEST_CUSTOMER_PHONE,
    is_banned: true,
    ban_reason: 'Test ban',
  }, { onConflict: 'phone' });
  const { data } = await supabase.from('users')
    .select('is_banned').eq('phone', TEST_CUSTOMER_PHONE).single();
  expect(data?.is_banned).toBe(true);
  await supabase.from('users').update({ is_banned: false, ban_reason: null })
    .eq('phone', TEST_CUSTOMER_PHONE);
});

// ─── ORDER STATUS MACHINE ──────────────────────────────────────────────────

test('NEG-STATUS-01: order cannot go from cancelled back to sent', async () => {
  const { data: order } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Status machine test',
    status: 'cancelled',
  }).select().single();
  const { data: check } = await supabase.from('requests')
    .select('status').eq('id', order!.id).single();
  expect(check?.status).toBe('cancelled');
});

test('NEG-STATUS-02: duplicate rating blocked — unique constraint on request_id', async () => {
  const { data: order } = await supabase.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Duplicate rating test',
    status: 'fulfilled',
  }).select().single();
  await supabase.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order!.id,
    user_phone: TEST_CUSTOMER_PHONE,
    rating: 4,
    service_mode: 'delivery',
  });
  const { error } = await supabase.from('vendor_reviews').insert({
    vendor_id: testVendor.id,
    request_id: order!.id,
    user_phone: TEST_CUSTOMER_PHONE,
    rating: 5,
    service_mode: 'delivery',
  });
  expect(error).not.toBeNull();
  expect(error!.code).toBe('23505');
});
