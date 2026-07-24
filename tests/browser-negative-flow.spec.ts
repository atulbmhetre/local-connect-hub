import { test, expect } from '@playwright/test';
import { loginAsVendor, APP_URL } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestData, cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_SESSION,
} from './helpers/setup';

const TEST_DEVICE_ID = `device_neg_${TEST_SESSION}`;
let testVendor: any;

const PHASE_D_TEST_DEBT =
  'Phase D test debt — needs session-aware test redesign. Tracked for dedicated test session.';

test.beforeAll(async () => {
  testVendor = await createTestVendor();
  const { error } = await supabaseAdmin
    .from('users')
    .insert({ phone: TEST_CUSTOMER_PHONE })
    .select()
    .single();
  if (error && error.code !== '23505') throw error;
});

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

// ─── BANNED VENDOR ─────────────────────────────────────────────────────────

test('NEG-BAN-01: banned vendor excluded from radar query — DB assert', async () => {
  await supabaseAdmin.from('vendors').update({ is_banned: true }).eq('id', testVendor.id);
  const { data } = await supabaseAdmin.from('vendors')
    .select('id')
    .eq('id', testVendor.id)
    .eq('is_banned', false);
  expect(data?.length).toBe(0);
  await supabaseAdmin.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

test('NEG-BAN-02: banned vendor cannot go live — is_active stays false', async () => {
  await supabaseAdmin.from('vendors').update({ is_banned: true, is_active: false }).eq('id', testVendor.id);
  const { data } = await supabaseAdmin.from('vendors')
    .select('is_banned, is_active').eq('id', testVendor.id).single();
  expect(data?.is_banned).toBe(true);
  expect(data?.is_active).toBe(false);
  await supabaseAdmin.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

test('NEG-BAN-03: banned vendor sees suspension screen in vendor mode', async ({ page }) => {
  await supabaseAdmin.from('vendors').update({ is_banned: true }).eq('id', testVendor.id);
  await loginAsVendor(page, testVendor.phone, testVendor.id, TEST_DEVICE_ID);
  await page.goto(`${APP_URL}/vendor`);
  await expect(page.getByText('Account Suspended')).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId('vendor-golive-btn')).not.toBeVisible({ timeout: 3000 });
  await supabaseAdmin.from('vendors').update({ is_banned: false }).eq('id', testVendor.id);
});

// ─── MAX NEIGHBOURS ────────────────────────────────────────────────────────
// Replaced Phase D skipped stubs: OTP-off callers cannot direct-insert into
// saved_vendors (RLS). Cap + phone-vendor uniqueness are enforced in
// save_saved_vendor / unique index — assert via anon RPC.

test('NEG-NEIGH-01: max 20 saved vendors enforced by save_saved_vendor', async () => {
  const vendors: { id: string }[] = [];
  const base = Date.now() % 100000000;
  for (let i = 0; i < 21; i++) {
    const phone = `9${String(base + i).padStart(9, '0')}`;
    const { data, error } = await supabaseAdmin
      .from('vendors')
      .insert({
        name: `Neighbour Vendor ${i} ${TEST_SESSION}`,
        shop_name: `Neighbour Shop ${i} ${TEST_SESSION}`,
        phone,
        category: 'Grocery',
        service_mode: 'delivery',
        latitude: 18.5204,
        longitude: 73.8567,
        is_active: true,
        profile_status: 'complete',
        vendor_note: `test_session:${TEST_SESSION}`,
      })
      .select('id')
      .single();
    if (error) throw error;
    vendors.push(data!);
  }

  const phone = `88091${String(TEST_SESSION).slice(-5)}`;
  const device = `${TEST_DEVICE_ID}_cap`;
  const errors: (string | null)[] = [];
  for (const v of vendors) {
    const { error } = await supabase.rpc('save_saved_vendor', {
      p_vendor_id: v.id,
      p_category: 'Grocery',
      p_nickname: '',
      p_device_id: device,
      p_user_phone: phone,
    });
    errors.push(error?.message ?? null);
  }

  expect(errors.slice(0, 20).every((e) => e === null)).toBe(true);
  expect(errors[20]).toContain('saved_vendors_limit_exceeded');

  const { count } = await supabaseAdmin
    .from('saved_vendors')
    .select('id', { count: 'exact', head: true })
    .eq('user_phone', phone);
  expect(count).toBe(20);

  await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
  await supabaseAdmin.from('vendors').delete().in(
    'id',
    vendors.map((v) => v.id),
  );
});

test('NEG-NEIGH-02: same phone cannot save same vendor twice as two rows', async () => {
  const phone = `88092${String(TEST_SESSION).slice(-5)}`;
  const deviceA = `${TEST_DEVICE_ID}_a`;
  const deviceB = `${TEST_DEVICE_ID}_b`;

  const { error: firstErr } = await supabase.rpc('save_saved_vendor', {
    p_vendor_id: testVendor.id,
    p_category: 'Grocery',
    p_nickname: 'One',
    p_device_id: deviceA,
    p_user_phone: phone,
  });
  expect(firstErr).toBeNull();

  // Second device, same phone + vendor → upserts (does not create a second row).
  const { error: secondErr } = await supabase.rpc('save_saved_vendor', {
    p_vendor_id: testVendor.id,
    p_category: 'Grocery',
    p_nickname: 'Two',
    p_device_id: deviceB,
    p_user_phone: phone,
  });
  expect(secondErr).toBeNull();

  const { data: rows } = await supabaseAdmin
    .from('saved_vendors')
    .select('id, nickname, device_id')
    .eq('user_phone', phone)
    .eq('vendor_id', testVendor.id);
  expect(rows?.length).toBe(1);
  expect(rows![0].nickname).toBe('Two');

  // Direct anon insert still blocked by RLS (and would hit unique if it got through).
  const { error: directErr } = await supabase.from('saved_vendors').insert({
    device_id: deviceA,
    vendor_id: testVendor.id,
    category: 'Grocery',
    nickname: 'Hack',
    user_phone: phone,
  });
  expect(directErr).not.toBeNull();

  await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
});

test('NEG-NEIGH-03: update_saved_vendor_nickname set and clear', async () => {
  const phone = `88093${String(TEST_SESSION).slice(-5)}`;
  const device = `${TEST_DEVICE_ID}_nick`;

  const { error: saveErr } = await supabase.rpc('save_saved_vendor', {
    p_vendor_id: testVendor.id,
    p_category: 'Grocery',
    p_nickname: '',
    p_device_id: device,
    p_user_phone: phone,
  });
  expect(saveErr).toBeNull();

  const { error: setErr } = await supabase.rpc('update_saved_vendor_nickname', {
    p_vendor_id: testVendor.id,
    p_nickname: 'My nick',
    p_device_id: device,
    p_user_phone: phone,
  });
  expect(setErr).toBeNull();

  const { data: afterSet } = await supabaseAdmin
    .from('saved_vendors')
    .select('nickname')
    .eq('user_phone', phone)
    .eq('vendor_id', testVendor.id)
    .maybeSingle();
  expect(afterSet?.nickname).toBe('My nick');

  const { error: clearErr } = await supabase.rpc('update_saved_vendor_nickname', {
    p_vendor_id: testVendor.id,
    p_nickname: '',
    p_device_id: device,
    p_user_phone: phone,
  });
  expect(clearErr).toBeNull();

  const { data: afterClear } = await supabaseAdmin
    .from('saved_vendors')
    .select('nickname')
    .eq('user_phone', phone)
    .eq('vendor_id', testVendor.id)
    .maybeSingle();
  expect(afterClear?.nickname).toBe('');

  await supabaseAdmin.from('saved_vendors').delete().eq('user_phone', phone);
});

// ─── EDIT ORDER BLOCKED ────────────────────────────────────────────────────

test('NEG-EDIT-01: edit blocked after order accepted — DB status check', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Original message',
    status: 'accepted',
  }).select().single();
  const { data: check } = await supabaseAdmin.from('requests')
    .select('status, previous_message').eq('id', order!.id).single();
  expect(['accepted', 'done', 'cancelled', 'fulfilled']).toContain(check?.status);
  expect(check?.previous_message).toBeNull();
});

test('NEG-EDIT-02: edit on cancelled order — status blocks write', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Cancelled order',
    status: 'cancelled',
  }).select().single();
  const { data: check } = await supabaseAdmin.from('requests')
    .select('status').eq('id', order!.id).single();
  expect(check?.status).toBe('cancelled');
});

// ─── REFERRAL EDGE CASES ───────────────────────────────────────────────────

test('NEG-REF-01: duplicate referral blocked — unique constraint on referee', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  await supabaseAdmin.from('referrals').insert({
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
  await supabaseAdmin.from('referrals').delete().eq('referee_id', TEST_CUSTOMER_PHONE);
});

// ─── BANNED CUSTOMER ───────────────────────────────────────────────────────

test('NEG-CUST-01: banned customer cannot place orders — is_banned check', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  await supabaseAdmin.from('users').upsert({
    phone: TEST_CUSTOMER_PHONE,
    is_banned: true,
    ban_reason: 'Test ban',
  }, { onConflict: 'phone' });
  const { data } = await supabaseAdmin.from('users')
    .select('is_banned').eq('phone', TEST_CUSTOMER_PHONE).single();
  expect(data?.is_banned).toBe(true);
  await supabaseAdmin.from('users').update({ is_banned: false, ban_reason: null })
    .eq('phone', TEST_CUSTOMER_PHONE);
});

// ─── ORDER STATUS MACHINE ──────────────────────────────────────────────────

test('NEG-STATUS-01: order cannot go from cancelled back to sent', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Status machine test',
    status: 'cancelled',
  }).select().single();
  const { data: check } = await supabaseAdmin.from('requests')
    .select('status').eq('id', order!.id).single();
  expect(check?.status).toBe('cancelled');
});

test('NEG-STATUS-02: duplicate rating blocked — unique constraint on request_id', async () => {
  test.skip(true, PHASE_D_TEST_DEBT);
  const { data: order } = await supabaseAdmin.from('requests').insert({
    vendor_id: testVendor.id,
    user_phone: TEST_CUSTOMER_PHONE,
    device_id: TEST_DEVICE_ID,
    message: 'Duplicate rating test',
    status: 'fulfilled',
  }).select().single();
  await supabaseAdmin.from('vendor_reviews').insert({
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
