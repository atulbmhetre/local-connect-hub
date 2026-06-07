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
