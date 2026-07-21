/**
 * Notifications client-surface hardening:
 * dual phone+device inbox mutations, rate limits, unread count RPC, FCM reassignment.
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabase, supabaseAdmin } from './helpers/setup';
import { uniqueTestPhone } from './helpers/session38';

dotenv.config({ path: '.env.test' });

const T = Date.now();
const ANON_URL = process.env.VITE_SUPABASE_URL!;
const ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY!;

function nextPhone(prefix: string): string {
  return uniqueTestPhone(prefix);
}

test.describe('notification client surface hardening', () => {
  const phones: string[] = [];
  const deviceIds: string[] = [];
  const notifIds: string[] = [];
  const rlIdentifiers: string[] = [];

  test.afterAll(async () => {
    if (notifIds.length) {
      await supabaseAdmin.from('user_notifications').delete().in('id', notifIds);
    }
    for (const phone of phones) {
      await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
      await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
      await supabaseAdmin.from('users').delete().eq('phone', phone);
    }
    for (const id of [...rlIdentifiers, ...phones, ...deviceIds]) {
      await supabaseAdmin.from('edge_function_rate_limits').delete().eq('identifier', id);
    }
  });

  test('NCS-01 — wrong device_id is rejected on inbox mutations', async () => {
    const phone = nextPhone('88101');
    const deviceOk = `dev_ok_${T}`;
    const deviceBad = `dev_bad_${T}`;
    phones.push(phone);
    deviceIds.push(deviceOk, deviceBad);

    await supabaseAdmin.from('users').upsert({ phone, trust_score: 70 }, { onConflict: 'phone' });
    await supabaseAdmin.from('user_devices').upsert({
      user_phone: phone,
      device_id: deviceOk,
      fcm_token: null,
    });

    const { data: row, error: insErr } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_phone: phone,
        type: 'test_ncs',
        title: 'ncs',
        body: `ncs-wrong-device-${T}`,
        is_read: false,
        is_informational: false,
      })
      .select('id')
      .single();
    expect(insErr, insErr?.message).toBeNull();
    notifIds.push(row!.id);

    const { error: markErr } = await supabase.rpc('mark_user_notification_read', {
      p_user_phone: phone,
      p_device_id: deviceBad,
      p_notification_id: row!.id,
    });
    expect(markErr?.message ?? '').toContain('not_found_or_unauthorized');

    const { error: delErr } = await supabase.rpc('delete_user_notification', {
      p_user_phone: phone,
      p_device_id: deviceBad,
      p_notification_id: row!.id,
    });
    expect(delErr?.message ?? '').toContain('not_found_or_unauthorized');

    const { error: clearErr } = await supabase.rpc('clear_user_notifications', {
      p_user_phone: phone,
      p_device_id: deviceBad,
    });
    expect(clearErr?.message ?? '').toContain('not_found_or_unauthorized');

    const { error: markAllErr } = await supabase.rpc('mark_user_notifications_read', {
      p_user_phone: phone,
      p_device_id: deviceBad,
      p_informational_only: false,
    });
    expect(markAllErr?.message ?? '').toContain('not_found_or_unauthorized');
  });

  test('NCS-02 — phone spoof with caller device_id (non-matching) is rejected', async () => {
    const victim = nextPhone('88102');
    const attacker = nextPhone('88103');
    const attackerDevice = `dev_atk_${T}`;
    phones.push(victim, attacker);
    deviceIds.push(attackerDevice);

    await supabaseAdmin.from('users').upsert(
      [
        { phone: victim, trust_score: 70 },
        { phone: attacker, trust_score: 70 },
      ],
      { onConflict: 'phone' },
    );
    await supabaseAdmin.from('user_devices').upsert({
      user_phone: attacker,
      device_id: attackerDevice,
      fcm_token: null,
    });

    const { data: row, error: insErr } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_phone: victim,
        type: 'test_ncs',
        title: 'victim',
        body: `ncs-spoof-${T}`,
        is_read: false,
        is_informational: false,
      })
      .select('id')
      .single();
    expect(insErr, insErr?.message).toBeNull();
    notifIds.push(row!.id);

    // Anon client: attacker supplies victim phone + own device (no victim↔device row).
    const { error } = await supabase.rpc('mark_user_notification_read', {
      p_user_phone: victim,
      p_device_id: attackerDevice,
      p_notification_id: row!.id,
    });
    expect(error?.message ?? '').toContain('not_found_or_unauthorized');

    const { data: still } = await supabaseAdmin
      .from('user_notifications')
      .select('is_read')
      .eq('id', row!.id)
      .single();
    expect(still?.is_read).toBe(false);
  });

  test('NCS-03 — inbox mutation RPCs are rate limited (30 / 60s)', async () => {
    const phone = nextPhone('88104');
    const deviceId = `dev_rl_${T}`;
    phones.push(phone);
    deviceIds.push(deviceId);
    rlIdentifiers.push(phone);

    await supabaseAdmin.from('users').upsert({ phone, trust_score: 70 }, { onConflict: 'phone' });
    await supabaseAdmin.from('user_devices').upsert({
      user_phone: phone,
      device_id: deviceId,
      fcm_token: null,
    });

    const { data: row, error: insErr } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_phone: phone,
        type: 'test_ncs',
        title: 'rl',
        body: `ncs-rl-${T}`,
        is_read: false,
        is_informational: true,
      })
      .select('id')
      .single();
    expect(insErr, insErr?.message).toBeNull();
    notifIds.push(row!.id);

    const errors: (string | null)[] = [];
    for (let i = 0; i < 31; i++) {
      const { error } = await supabase.rpc('mark_user_notifications_read', {
        p_user_phone: phone,
        p_device_id: deviceId,
        p_informational_only: true,
      });
      errors.push(error?.message ?? null);
    }
    expect(errors.slice(0, 30).every((e) => e === null)).toBe(true);
    expect(errors[30]).toContain('rate_limited');
  });

  test('NCS-04 — unread count RPC returns true COUNT past the 100-row tray cap', async () => {
    const phone = nextPhone('88105');
    const deviceId = `dev_cnt_${T}`;
    phones.push(phone);
    deviceIds.push(deviceId);

    await supabaseAdmin.from('users').upsert({ phone, trust_score: 70 }, { onConflict: 'phone' });
    await supabaseAdmin.from('user_devices').upsert({
      user_phone: phone,
      device_id: deviceId,
      fcm_token: null,
    });

    const rows = Array.from({ length: 105 }, (_, i) => ({
      user_phone: phone,
      type: 'test_ncs',
      title: `u${i}`,
      body: `ncs-count-${T}-${i}`,
      is_read: false,
      is_informational: false,
    }));
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('user_notifications')
      .insert(rows)
      .select('id');
    expect(insErr, insErr?.message).toBeNull();
    for (const r of inserted ?? []) notifIds.push(r.id);

    const { data: capped, error: capErr } = await supabase.rpc('get_user_notifications', {
      p_user_phone: phone,
      p_device_id: deviceId,
      p_limit: 100,
    });
    expect(capErr, capErr?.message).toBeNull();
    const cappedUnread = (Array.isArray(capped) ? capped : []).filter(
      (n: { is_read: boolean }) => !n.is_read,
    ).length;
    expect(cappedUnread).toBe(100);

    const { data: count, error: countErr } = await supabase.rpc(
      'get_user_unread_notification_count',
      {
        p_user_phone: phone,
        p_device_id: deviceId,
      },
    );
    expect(countErr, countErr?.message).toBeNull();
    expect(count).toBe(105);
  });

  test('NCS-05 — upsert_user_device clears fcm_token from prior phone on same device', async () => {
    const phoneA = nextPhone('88106');
    const phoneB = nextPhone('88107');
    const deviceId = `dev_fcm_${T}`;
    const token = `fcm_token_${T}`;
    phones.push(phoneA, phoneB);
    deviceIds.push(deviceId);

    await supabaseAdmin.from('users').upsert(
      [
        { phone: phoneA, trust_score: 70 },
        { phone: phoneB, trust_score: 70 },
      ],
      { onConflict: 'phone' },
    );

    const { error: upA } = await supabaseAdmin.rpc('upsert_user_device', {
      p_user_phone: phoneA,
      p_device_id: deviceId,
      p_fcm_token: token,
      p_last_lat: null,
      p_last_lng: null,
    });
    expect(upA, upA?.message).toBeNull();

    const { error: upB } = await supabaseAdmin.rpc('upsert_user_device', {
      p_user_phone: phoneB,
      p_device_id: deviceId,
      p_fcm_token: token,
      p_last_lat: null,
      p_last_lng: null,
    });
    expect(upB, upB?.message).toBeNull();

    const { data: rowA } = await supabaseAdmin
      .from('user_devices')
      .select('fcm_token')
      .eq('user_phone', phoneA)
      .eq('device_id', deviceId)
      .maybeSingle();
    const { data: rowB } = await supabaseAdmin
      .from('user_devices')
      .select('fcm_token')
      .eq('user_phone', phoneB)
      .eq('device_id', deviceId)
      .maybeSingle();

    expect(rowA?.fcm_token).toBeNull();
    expect(rowB?.fcm_token).toBe(token);
  });

  test('NCS-06 — matching phone+device can mark read', async () => {
    const phone = nextPhone('88108');
    const deviceId = `dev_ok2_${T}`;
    phones.push(phone);
    deviceIds.push(deviceId);

    await supabaseAdmin.from('users').upsert({ phone, trust_score: 70 }, { onConflict: 'phone' });
    await supabaseAdmin.from('user_devices').upsert({
      user_phone: phone,
      device_id: deviceId,
      fcm_token: null,
    });

    const { data: row, error: insErr } = await supabaseAdmin
      .from('user_notifications')
      .insert({
        user_phone: phone,
        type: 'test_ncs',
        title: 'ok',
        body: `ncs-ok-${T}`,
        is_read: false,
        is_informational: false,
      })
      .select('id')
      .single();
    expect(insErr, insErr?.message).toBeNull();
    notifIds.push(row!.id);

    const anon = createClient(ANON_URL, ANON_KEY);
    const { error } = await anon.rpc('mark_user_notification_read', {
      p_user_phone: phone,
      p_device_id: deviceId,
      p_notification_id: row!.id,
    });
    expect(error, error?.message).toBeNull();

    const { data: after } = await supabaseAdmin
      .from('user_notifications')
      .select('is_read')
      .eq('id', row!.id)
      .single();
    expect(after?.is_read).toBe(true);
  });
});
