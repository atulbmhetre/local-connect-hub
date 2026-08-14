/**
 * vendor_devices multi-device push: upsert_vendor_device RPC, notify-vendor
 * looping every registered device token, and the pre-migration legacy-token
 * fallback (vendors.fcm_token still works when no vendor_devices rows exist).
 */
import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  createTestVendor,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';

const T = Date.now();

async function invokeNotifyVendor(record: Record<string, unknown>) {
  return supabase.functions.invoke('notify-vendor', { body: { record } });
}

async function queryFcmLogs(targetPhone: string, notificationType: string) {
  const { data, error } = await supabaseAdmin
    .from('fcm_delivery_log')
    .select('id, raw_response, created_at')
    .eq('target_phone', targetPhone)
    .eq('notification_type', notificationType);
  if (error) throw error;
  return data ?? [];
}

/** Poll until at least `minNewRows` new log rows appear (no created_at filter — avoids client/server clock skew). */
async function waitForNewFcmLogs(
  targetPhone: string,
  notificationType: string,
  minNewRows: number,
  baselineCount: number,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await queryFcmLogs(targetPhone, notificationType);
    if (rows.length >= baselineCount + minNewRows) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
  return queryFcmLogs(targetPhone, notificationType);
}

test.describe('vendor_devices multi-device push', () => {
  let vendor: { id: string; phone: string };

  test.beforeAll(async () => {
    vendor = await createTestVendor({ shop_name: `VendorDevices-${TEST_SESSION}` });
  });

  test.afterAll(async () => {
    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('fcm_delivery_log').delete().eq('target_phone', vendor.phone);
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', vendor.phone);
    await cleanupTestVendors();
  });

  test.afterEach(async () => {
    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', vendor.id);
  });

  test('VD-RPC-01: upsert_vendor_device creates a row and mirrors the token onto vendors.fcm_token', async () => {
    const token = `vd_rpc01_${T}`;
    const { error } = await supabase.rpc('upsert_vendor_device', {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_device_id: `device_a_${T}`,
      p_fcm_token: token,
    });
    expect(error, error?.message).toBeNull();

    const { data: row } = await supabaseAdmin
      .from('vendor_devices')
      .select('fcm_token')
      .eq('vendor_id', vendor.id)
      .eq('device_id', `device_a_${T}`)
      .maybeSingle();
    expect(row?.fcm_token).toBe(token);

    const { data: vendorRow } = await supabaseAdmin
      .from('vendors')
      .select('fcm_token')
      .eq('id', vendor.id)
      .single();
    expect(vendorRow?.fcm_token).toBe(token);
  });

  test('VD-RPC-02: upsert_vendor_device rejects a phone that does not match the vendor', async () => {
    const { error } = await supabase.rpc('upsert_vendor_device', {
      p_vendor_id: vendor.id,
      p_vendor_phone: '0000000000',
      p_device_id: `device_bad_${T}`,
      p_fcm_token: `vd_rpc02_${T}`,
    });
    expect(error).not.toBeNull();
    expect(error?.message ?? '').toContain('not_found_or_unauthorized');
  });

  test('VD-RPC-03: upsert_vendor_device upserts on (vendor_id, device_id) instead of duplicating', async () => {
    const deviceId = `device_upsert_${T}`;
    await supabase.rpc('upsert_vendor_device', {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_device_id: deviceId,
      p_fcm_token: `vd_rpc03_first_${T}`,
    });
    await supabase.rpc('upsert_vendor_device', {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_device_id: deviceId,
      p_fcm_token: `vd_rpc03_second_${T}`,
    });

    const { data: rows } = await supabaseAdmin
      .from('vendor_devices')
      .select('fcm_token')
      .eq('vendor_id', vendor.id)
      .eq('device_id', deviceId);
    expect(rows?.length).toBe(1);
    expect(rows?.[0]?.fcm_token).toBe(`vd_rpc03_second_${T}`);
  });

  test('VD-01: vendor with 2 registered devices gets an FCM delivery attempt logged for each token', async () => {
    const baseline = (await queryFcmLogs(vendor.phone, 'vendor-payment_claimed')).length;
    await supabaseAdmin.from('vendor_devices').insert([
      { vendor_id: vendor.id, device_id: `multi_a_${T}`, fcm_token: `vd_multi_a_${T}` },
      { vendor_id: vendor.id, device_id: `multi_b_${T}`, fcm_token: `vd_multi_b_${T}` },
    ]);

    const { data, error } = await invokeNotifyVendor({
      vendor_id: vendor.id,
      notification_title: `Multi-device push ${T}`,
      message: `Two devices — ${T}`,
      type: 'payment_claimed',
      skip_inbox: true,
    });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const logs = await waitForNewFcmLogs(vendor.phone, 'vendor-payment_claimed', 2, baseline);
    expect(logs.length).toBeGreaterThanOrEqual(baseline + 2);
  });

  test('VD-02: legacy pre-migration vendor (single vendors.fcm_token, no device rows) still receives', async () => {
    const baseline = (await queryFcmLogs(vendor.phone, 'vendor-payment_claimed')).length;
    const legacyToken = `vd_legacy_${T}`;

    // Simulate a vendor from before this migration: no vendor_devices rows,
    // only the single vendors.fcm_token column populated.
    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendors').update({ fcm_token: legacyToken }).eq('id', vendor.id);

    const { data, error } = await invokeNotifyVendor({
      vendor_id: vendor.id,
      notification_title: `Legacy token push ${T}`,
      message: `Legacy fallback — ${T}`,
      type: 'payment_claimed',
      skip_inbox: true,
    });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const logs = await waitForNewFcmLogs(vendor.phone, 'vendor-payment_claimed', 1, baseline);
    expect(logs.length).toBeGreaterThanOrEqual(baseline + 1);
  });

  test('VD-03: an actual legacy vendor_devices row (device_id="legacy") is used the same way', async () => {
    const baseline = (await queryFcmLogs(vendor.phone, 'vendor-referral')).length;
    const legacyToken = `vd_legacy_row_${T}`;

    await supabaseAdmin.from('vendors').update({ fcm_token: null }).eq('id', vendor.id);
    await supabaseAdmin
      .from('vendor_devices')
      .insert({ vendor_id: vendor.id, device_id: 'legacy', fcm_token: legacyToken });

    const { data, error } = await invokeNotifyVendor({
      vendor_id: vendor.id,
      notification_title: `Legacy row push ${T}`,
      message: `Legacy row — ${T}`,
      type: 'referral',
      skip_inbox: true,
    });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const logs = await waitForNewFcmLogs(vendor.phone, 'vendor-referral', 1, baseline);
    expect(logs.length).toBeGreaterThanOrEqual(baseline + 1);
  });

  test('VD-04: notify-vendor fcm_delivery_log uses the real notification type, not a hardcoded label', async () => {
    const paymentBaseline = (await queryFcmLogs(vendor.phone, 'vendor-payment_claimed')).length;
    await supabaseAdmin
      .from('vendor_devices')
      .insert({ vendor_id: vendor.id, device_id: `type_${T}`, fcm_token: `vd_type_${T}` });

    const { error } = await invokeNotifyVendor({
      vendor_id: vendor.id,
      notification_title: `Type label push ${T}`,
      message: `Type label — ${T}`,
      type: 'payment_claimed',
      skip_inbox: true,
    });
    expect(error).toBeNull();

    const mislabeled = await queryFcmLogs(vendor.phone, 'vendor-new-order');
    expect(mislabeled.length).toBe(0);

    const correctlyLabeled = await waitForNewFcmLogs(
      vendor.phone,
      'vendor-payment_claimed',
      1,
      paymentBaseline,
    );
    expect(correctlyLabeled.length).toBeGreaterThanOrEqual(paymentBaseline + 1);
  });

  test('VD-05: notify-vendor with no token logs vendor-no_fcm_token (not silent)', async () => {
    const baseline = (await queryFcmLogs(vendor.phone, 'vendor-no_fcm_token')).length;
    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', vendor.id);
    await supabaseAdmin.from('vendors').update({ fcm_token: null }).eq('id', vendor.id);

    const { data, error } = await invokeNotifyVendor({
      vendor_id: vendor.id,
      notification_title: `No token ${T}`,
      message: `No token body — ${T}`,
      type: 'payment_claimed',
      skip_inbox: true,
    });
    expect(error).toBeNull();
    expect(data).toMatchObject({ ok: true, fcm_skipped: true, reason: 'no_vendor_token' });

    const logs = await waitForNewFcmLogs(vendor.phone, 'vendor-no_fcm_token', 1, baseline);
    expect(logs.length).toBeGreaterThanOrEqual(baseline + 1);
    expect(logs[logs.length - 1]?.raw_response).toContain(vendor.id);
  });

  test('VD-06: new vendor with immediate token receives FCM on first new_order', async () => {
    const freshVendor = await createTestVendor({ shop_name: `VendorDevicesEarly-${T}` });
    const token = `vd_early_${T}`;
    const deviceId = `early_device_${T}`;

    const { error: upsertErr } = await supabase.rpc('upsert_vendor_device', {
      p_vendor_id: freshVendor.id,
      p_vendor_phone: freshVendor.phone,
      p_device_id: deviceId,
      p_fcm_token: token,
    });
    expect(upsertErr, upsertErr?.message).toBeNull();

    const { data: deviceRow } = await supabaseAdmin
      .from('vendor_devices')
      .select('fcm_token')
      .eq('vendor_id', freshVendor.id)
      .eq('device_id', deviceId)
      .maybeSingle();
    expect(deviceRow?.fcm_token).toBe(token);

    const baseline = (await queryFcmLogs(freshVendor.phone, 'vendor-new_order')).length;

    const { data, error } = await invokeNotifyVendor({
      vendor_id: freshVendor.id,
      notification_title: `Early token order ${T}`,
      message: `Immediate order — ${T}`,
      type: 'new_order',
      skip_inbox: true,
    });
    expect(error).toBeNull();
    expect(data).toEqual({ ok: true });

    const logs = await waitForNewFcmLogs(freshVendor.phone, 'vendor-new_order', 1, baseline);
    expect(logs.length).toBeGreaterThanOrEqual(baseline + 1);

    await supabaseAdmin.from('vendor_devices').delete().eq('vendor_id', freshVendor.id);
    await supabaseAdmin.from('fcm_delivery_log').delete().eq('target_phone', freshVendor.phone);
    await supabaseAdmin.from('vendors').delete().eq('id', freshVendor.id);
  });
});
