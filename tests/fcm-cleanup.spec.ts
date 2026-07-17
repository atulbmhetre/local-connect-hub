import { test, expect } from '@playwright/test';
import { supabaseAdmin, deleteStaleToken, uniqueTestPhone, cleanupSession38Data } from './helpers/session38';
import { TEST_SESSION } from './helpers/setup';

const CUSTOMER_PHONE = uniqueTestPhone('88003');
const DEVICE_A = `device_fcm_a_${TEST_SESSION}`;
const DEVICE_B = `device_fcm_b_${TEST_SESSION}`;
const TOKEN_A = `fcm_token_a_${TEST_SESSION}`;
const TOKEN_B = `fcm_token_b_${TEST_SESSION}`;
const MISSING_TOKEN = `fcm_missing_${TEST_SESSION}`;

test.beforeAll(async () => {
  await supabaseAdmin.from('user_devices').insert([
    {
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_A,
      fcm_token: TOKEN_A,
    },
    {
      user_phone: CUSTOMER_PHONE,
      device_id: DEVICE_B,
      fcm_token: TOKEN_B,
    },
  ]);
});

test.afterAll(async () => {
  await supabaseAdmin.from('user_devices').delete().eq('user_phone', CUSTOMER_PHONE);
  await cleanupSession38Data([CUSTOMER_PHONE]);
});

test('FCM-01: deleteStaleToken removes the matching user_devices row', async () => {
  await deleteStaleToken(TOKEN_A);

  const { data: remainingA } = await supabaseAdmin
    .from('user_devices')
    .select('id')
    .eq('fcm_token', TOKEN_A);
  expect(remainingA).toEqual([]);

  const { data: remainingB } = await supabaseAdmin
    .from('user_devices')
    .select('id')
    .eq('fcm_token', TOKEN_B);
  expect(remainingB?.length).toBe(1);
});

test('FCM-02: deleteStaleToken does not throw when token does not exist', async () => {
  await expect(deleteStaleToken(MISSING_TOKEN)).resolves.toBeUndefined();
});

test('FCM-03: deleteStaleToken does not remove other tokens for same user', async () => {
  await deleteStaleToken(TOKEN_B);

  const { data } = await supabaseAdmin
    .from('user_devices')
    .select('fcm_token')
    .eq('user_phone', CUSTOMER_PHONE);

  expect(data?.map((r) => r.fcm_token)).toEqual([]);
});

test('FCM-04: deleteStaleToken clears matching vendors.fcm_token', async () => {
  const vendorPhone = uniqueTestPhone('99071');
  const token = `vendor_fcm_${TEST_SESSION}`;
  const { data: vendor, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'FCM Vendor',
      shop_name: `!FCM-${TEST_SESSION}`,
      phone: vendorPhone,
      category: 'General Store',
      service_mode: 'delivery',
      fcm_token: token,
      is_active: false,
      profile_status: 'complete',
    })
    .select('id')
    .single();
  expect(error, error?.message).toBeNull();

  await deleteStaleToken(token);

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('fcm_token')
    .eq('id', vendor!.id)
    .single();
  expect(after?.fcm_token == null || after?.fcm_token === '').toBe(true);

  await supabaseAdmin.from('vendors').delete().eq('id', vendor!.id);
});
