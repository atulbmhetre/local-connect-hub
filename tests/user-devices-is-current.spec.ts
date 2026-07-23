import { test, expect } from '@playwright/test';
import { supabaseAdmin, TEST_SESSION } from './helpers/setup';

const T = Date.now();
let phoneSeq = 0;
const phones: string[] = [];
const deviceIds: string[] = [];

function nextPhone(prefix: string): string {
  phoneSeq += 1;
  const phone = `${prefix}${String(T + phoneSeq).slice(-5)}`;
  phones.push(phone);
  return phone;
}

test.afterAll(async () => {
  if (deviceIds.length) {
    await supabaseAdmin.from('user_devices').delete().in('device_id', deviceIds);
  }
  if (phones.length) {
    await supabaseAdmin
      .from('edge_function_rate_limits')
      .delete()
      .in('identifier', deviceIds);
    await supabaseAdmin.from('users').delete().in('phone', phones);
  }
});

test('UD-CURRENT-01 — ensure_user_device_link keeps prior phone row, flips is_current', async () => {
  const phoneA = nextPhone('88201');
  const phoneB = nextPhone('88202');
  const deviceId = `dev_cur_${TEST_SESSION}_${T}`;
  deviceIds.push(deviceId);

  await supabaseAdmin.from('users').upsert(
    [
      { phone: phoneA, trust_score: 70 },
      { phone: phoneB, trust_score: 70 },
    ],
    { onConflict: 'phone' },
  );

  const { error: e1 } = await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phoneA,
    p_device_id: deviceId,
  });
  expect(e1, e1?.message).toBeNull();

  const { error: e2 } = await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phoneB,
    p_device_id: deviceId,
  });
  expect(e2, e2?.message).toBeNull();

  const { data: rows, error } = await supabaseAdmin
    .from('user_devices')
    .select('user_phone, is_current, fcm_token')
    .eq('device_id', deviceId)
    .order('user_phone');
  expect(error, error?.message).toBeNull();
  expect(rows).toHaveLength(2);

  const a = rows!.find((r) => r.user_phone === phoneA);
  const b = rows!.find((r) => r.user_phone === phoneB);
  expect(a?.is_current).toBe(false);
  expect(b?.is_current).toBe(true);
  expect(a?.fcm_token).toBeNull();
});

test('UD-CURRENT-02 — upsert_user_device marks current and clears prior token', async () => {
  const phoneA = nextPhone('88203');
  const phoneB = nextPhone('88204');
  const deviceId = `dev_cur_up_${TEST_SESSION}_${T}`;
  deviceIds.push(deviceId);
  const token = `tok_cur_${T}`;

  await supabaseAdmin.from('users').upsert(
    [
      { phone: phoneA, trust_score: 70 },
      { phone: phoneB, trust_score: 70 },
    ],
    { onConflict: 'phone' },
  );

  await supabaseAdmin.rpc('upsert_user_device', {
    p_user_phone: phoneA,
    p_device_id: deviceId,
    p_fcm_token: token,
    p_last_lat: null,
    p_last_lng: null,
  });
  await supabaseAdmin.rpc('upsert_user_device', {
    p_user_phone: phoneB,
    p_device_id: deviceId,
    p_fcm_token: token,
    p_last_lat: null,
    p_last_lng: null,
  });

  const { data: rows } = await supabaseAdmin
    .from('user_devices')
    .select('user_phone, is_current, fcm_token')
    .eq('device_id', deviceId);

  expect(rows).toHaveLength(2);
  expect(rows!.find((r) => r.user_phone === phoneA)?.is_current).toBe(false);
  expect(rows!.find((r) => r.user_phone === phoneA)?.fcm_token).toBeNull();
  expect(rows!.find((r) => r.user_phone === phoneB)?.is_current).toBe(true);
  expect(rows!.find((r) => r.user_phone === phoneB)?.fcm_token).toBe(token);
});

test('UD-CURRENT-03 — historical link still counts for delete-account ownership shape', async () => {
  // deviceOwnsPhone matches any (phone, device) row — not only is_current.
  const phoneA = nextPhone('88205');
  const phoneB = nextPhone('88206');
  const deviceId = `dev_cur_own_${TEST_SESSION}_${T}`;
  deviceIds.push(deviceId);

  await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phoneA,
    p_device_id: deviceId,
  });
  await supabaseAdmin.rpc('ensure_user_device_link', {
    p_user_phone: phoneB,
    p_device_id: deviceId,
  });

  const { data: hist } = await supabaseAdmin
    .from('user_devices')
    .select('id')
    .eq('device_id', deviceId)
    .eq('user_phone', phoneA)
    .eq('is_current', false)
    .maybeSingle();
  expect(hist?.id).toBeTruthy();
});
