/**
 * PROD spot-check: near-deadline cron auth + one real FCM hop (Help).
 * Usage: node scripts/probes/prod-probe-near-deadline-push.mjs
 */
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '.env.test.prod', override: true });

const PROD_REF = 'rpxsyeqskvhjmbkxnpmd';
const url = (process.env.VITE_SUPABASE_URL ?? '').trim();
const anonKey = (process.env.VITE_SUPABASE_ANON_KEY ?? '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1];

console.log('=== PROD near-deadline push spot-check ===');
console.log('project_ref:', ref);
console.log('expected:', PROD_REF);
if (ref !== PROD_REF) {
  console.error('ABORT: not PROD');
  process.exit(2);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const T = Date.now();
const customerPhone = `88172${String(T).slice(-5)}`;
const vendorPhone = `99172${String(T).slice(-5)}`;
const deviceId = `prod_nd_${T}`;
const created = { vendorIds: [], requestIds: [], deviceIds: [deviceId] };

async function cleanup() {
  if (created.requestIds.length) {
    await admin.from('user_notifications').delete().in('related_id', created.requestIds);
    await admin.from('requests').delete().in('id', created.requestIds);
  }
  await admin.from('user_devices').delete().eq('device_id', deviceId);
  for (const vendorId of created.vendorIds) {
    await admin.from('vendor_categories').delete().eq('vendor_id', vendorId);
    await admin.from('vendors').delete().eq('id', vendorId);
  }
  await admin.from('users').delete().eq('phone', customerPhone);
  await admin.from('users').delete().eq('phone', vendorPhone);
  await admin.from('user_notifications').delete().eq('user_phone', customerPhone);
}

try {
  const edgeRes = await fetch(`${url}/functions/v1/warn-near-deadline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const edgeText = await edgeRes.text();
  console.log('direct_edge_status:', edgeRes.status);
  console.log('direct_edge_body:', edgeText.slice(0, 200));
  if (edgeRes.status !== 200) {
    throw new Error(`direct edge invoke HTTP ${edgeRes.status}: ${edgeText}`);
  }

  const { data: cat, error: catErr } = await admin
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .eq('service_mode', 'help')
    .limit(1)
    .maybeSingle();
  if (catErr) throw catErr;
  if (!cat) throw new Error('no help category');

  const { data: vendor, error: vendErr } = await admin
    .from('vendors')
    .insert({
      name: `PROD ND Probe ${T}`,
      shop_name: `PROD ND ${T}`,
      phone: vendorPhone,
      category: cat.label,
      service_mode: 'help',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `prod_nd:${T}`,
    })
    .select('id')
    .single();
  if (vendErr) throw vendErr;
  created.vendorIds.push(vendor.id);

  await admin.from('users').upsert({ phone: customerPhone, trust_score: 70 }, { onConflict: 'phone' });

  const { data: order, error: ordErr } = await admin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: customerPhone,
      device_id: deviceId,
      message: `prod-nd-help-${T}`,
      status: 'sent',
      service_mode: 'help',
      category_id: cat.id,
    })
    .select('id')
    .single();
  if (ordErr) throw ordErr;
  created.requestIds.push(order.id);

  const { error: createdErr } = await admin
    .from('requests')
    .update({ created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() })
    .eq('id', order.id);
  if (createdErr) throw createdErr;

  const { error: warnErr } = await admin.rpc('warn_pending_orders_near_deadline');
  if (warnErr) throw warnErr;

  const { data: inbox } = await admin
    .from('user_notifications')
    .select('id, type, related_id')
    .eq('related_id', order.id)
    .in('type', ['order_near_deadline_unseen', 'order_near_deadline_unconfirmed'])
    .maybeSingle();

  await admin.from('user_devices').insert({
    user_phone: customerPhone,
    device_id: deviceId,
    fcm_token: `prod-nd-dummy-${T}`,
    is_current: true,
  });

  const since = new Date().toISOString();
  const hopRes = await fetch(`${url}/functions/v1/warn-near-deadline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const hopText = await hopRes.text();
  let hopJson = {};
  try {
    hopJson = JSON.parse(hopText);
  } catch {
    hopJson = { raw: hopText };
  }

  const { data: logs } = await admin
    .from('fcm_delivery_log')
    .select('notification_type, success_count, failure_count, raw_response')
    .eq('target_phone', customerPhone)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(3);

  const { data: requestRow } = await admin
    .from('requests')
    .select('near_deadline_warned_at, near_deadline_push_sent')
    .eq('id', order.id)
    .single();

  const result = {
    project_ref: ref,
    direct_edge_status: edgeRes.status,
    inbox_ok: Boolean(inbox?.id) && inbox.related_id === order.id,
    inbox_type: inbox?.type ?? null,
    hop_status: hopRes.status,
    hop_body: hopJson,
    notify_user_logged: (logs ?? []).length > 0,
    fcm_reached_google: (logs ?? []).some((row) =>
      /registration token|UNREGISTERED|not a valid FCM/i.test(String(row.raw_response ?? '')),
    ),
    warned: Boolean(requestRow?.near_deadline_warned_at),
    push_sent: requestRow?.near_deadline_push_sent ?? null,
    log_preview: (logs ?? []).map((row) => ({
      type: row.notification_type,
      success: row.success_count,
      failure: row.failure_count,
      raw: String(row.raw_response ?? '').slice(0, 100),
    })),
  };

  const ok =
    result.direct_edge_status === 200 &&
    result.inbox_ok &&
    result.warned &&
    result.hop_status === 200 &&
    result.notify_user_logged &&
    result.hop_status !== 401;

  console.log(JSON.stringify(result, null, 2));
  console.log(ok ? 'PASS' : 'FAIL');
  await cleanup();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error('SPOT-CHECK ERROR:', err);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error('cleanup failed', cleanupErr);
  }
  process.exit(1);
}
