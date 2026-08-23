/**
 * TEST live proof: near-deadline SQL inbox + warn-near-deadline → notify-user
 * for Help, Delivery, and Appointment.
 *
 * Usage: node scripts/probes/test-probe-near-deadline-push.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test', override: true });

const TEST_REF = 'hhdylnhqdzfabsolwxdz';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== TEST near-deadline push probe ===');
console.log('project_ref:', ref);
if (ref !== TEST_REF) {
  console.error('ABORT: not TEST');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const T = Date.now();
const customerPhone = `88171${String(T).slice(-5)}`;
const created = { vendorIds: [], requestIds: [], deviceIds: [] };

function minutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function categoryForMode(mode) {
  const { data, error } = await admin
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .eq('service_mode', mode)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`no category for ${mode}`);
  return data;
}

async function insertVendor(mode, phone) {
  const { data, error } = await admin
    .from('vendors')
    .insert({
      name: `ND Probe ${mode} ${T}`,
      shop_name: `ND ${mode} ${T}`,
      phone,
      category: 'Grocery',
      service_mode: mode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `nd_probe:${T}`,
    })
    .select('id')
    .single();
  if (error) throw error;
  created.vendorIds.push(data.id);
  return data.id;
}

async function invokeEdge() {
  const res = await fetch(`${url}/functions/v1/warn-near-deadline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function cleanup() {
  if (created.requestIds.length) {
    await admin.from('user_notifications').delete().in('related_id', created.requestIds);
    await admin.from('requests').delete().in('id', created.requestIds);
  }
  if (created.deviceIds.length) {
    await admin.from('user_devices').delete().in('device_id', created.deviceIds);
  }
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', customerPhone);
  await admin.from('user_notifications').delete().eq('user_phone', customerPhone);
}

async function runCase(mode, seed, phoneDigit) {
  const vendorPhone = `99${phoneDigit}${String(T).slice(-7)}`.slice(0, 10);
  const vendorId = await insertVendor(mode, vendorPhone);
  const cat = await categoryForMode(mode);
  const { data: order, error } = await admin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: `nd_probe_${mode}_${T}`,
      message: `nd-probe-${mode}-${T}`,
      status: seed.status,
      service_mode: mode,
      category_id: cat.id,
      delivery_slot: seed.delivery_slot ?? null,
      delivery_slot_deadline: seed.delivery_slot_deadline ?? null,
      appointment_time: seed.appointment_time ?? null,
      appointment_status: seed.appointment_status ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  created.requestIds.push(order.id);
  if (seed.created_at) {
    const { error: createdErr } = await admin
      .from('requests')
      .update({ created_at: seed.created_at })
      .eq('id', order.id);
    if (createdErr) throw createdErr;
  }

  const { error: warnErr } = await admin.rpc('warn_pending_orders_near_deadline');
  if (warnErr) throw warnErr;

  const { data: inbox } = await admin
    .from('user_notifications')
    .select('id, type, related_id')
    .eq('related_id', order.id)
    .in('type', ['order_near_deadline_unseen', 'order_near_deadline_unconfirmed'])
    .maybeSingle();

  const deviceId = `nd_probe_dev_${mode}_${T}`;
  created.deviceIds.push(deviceId);

  const token = (process.env.ND_PROBE_FCM_TOKEN ?? '').trim() || `dummy-nd-${mode}-${T}`;
  const usedRealToken = Boolean((process.env.ND_PROBE_FCM_TOKEN ?? '').trim());

  await admin.from('user_devices').insert({
    user_phone: customerPhone,
    device_id: deviceId,
    fcm_token: token,
    is_current: true,
  });

  const since = new Date().toISOString();
  const edge = await invokeEdge();

  const { data: logs } = await admin
    .from('fcm_delivery_log')
    .select('notification_type, success_count, failure_count, raw_response')
    .eq('target_phone', customerPhone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3);

  const { data: requestRow } = await admin
    .from('requests')
    .select('near_deadline_warned_at, near_deadline_push_sent, status, service_mode')
    .eq('id', order.id)
    .single();

  const fcmSuccess = (logs ?? []).some((row) => Number(row.success_count) > 0);

  return {
    mode,
    inbox_ok: Boolean(inbox?.id) && inbox.related_id === order.id,
    inbox_type: inbox?.type ?? null,
    edge_status: edge.status,
    edge_pushed: edge.json?.pushed ?? null,
    notify_user_logged: (logs ?? []).length > 0,
    fcm_success: fcmSuccess,
    used_real_token: usedRealToken,
    push_sent: requestRow?.near_deadline_push_sent ?? null,
    warned: Boolean(requestRow?.near_deadline_warned_at),
    log_preview: (logs ?? []).map((row) => ({
      type: row.notification_type,
      success: row.success_count,
      failure: row.failure_count,
      raw: String(row.raw_response ?? '').slice(0, 80),
    })),
  };
}

try {
  await admin.from('users').upsert({ phone: customerPhone, trust_score: 70 }, { onConflict: 'phone' });

  const results = [];
  results.push(
    await runCase('help', {
      status: 'sent',
      created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
    }, '1'),
  );
  results.push(
    await runCase('delivery', {
      status: 'sent',
      delivery_slot: 'evening',
      delivery_slot_deadline: minutesFromNow(45),
    }, '2'),
  );
  results.push(
    await runCase('appointment', {
      status: 'seen',
      appointment_time: minutesFromNow(40),
      appointment_status: 'pending',
    }, '3'),
  );

  const allOk = results.every(
    (row) =>
      row.inbox_ok &&
      row.warned &&
      row.edge_status === 200 &&
      row.notify_user_logged,
  );

  console.log(JSON.stringify({ project_ref: ref, results }, null, 2));
  console.log(allOk ? 'PASS' : 'FAIL');
  await cleanup();
  process.exit(allOk ? 0 : 1);
} catch (err) {
  console.error('PROBE ERROR:', err);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error('cleanup failed', cleanupErr);
  }
  process.exit(1);
}
