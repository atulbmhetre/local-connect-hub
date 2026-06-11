import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { supabase, TEST_SESSION } from './setup';

dotenv.config({ path: '.env.test' });

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY!;

export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, serviceRoleKey);

/** Mirrors PhoneEntrySheet checkExistingAccount (null when no row or total_orders <= 0). */
export async function checkExistingAccount(
  phone: string,
): Promise<{ total_orders: number; completed_orders: number } | null> {
  const { data, error } = await supabase
    .from('users')
    .select('total_orders, completed_orders')
    .eq('phone', phone)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const total_orders = data.total_orders ?? 0;
  const completed_orders = data.completed_orders ?? 0;
  if (total_orders <= 0) return null;
  return { total_orders, completed_orders };
}

/** Mirrors ParchiSheet.getDeliverySlotDeadline */
export function getDeliverySlotDeadline(slot: string | null): string | null {
  const now = new Date();

  if (slot === 'asap') {
    return new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  }
  if (slot === 'morning') {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === 'afternoon') {
    const d = new Date(now);
    d.setHours(16, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === 'evening') {
    const d = new Date(now);
    d.setHours(20, 0, 0, 0);
    return d.toISOString();
  }
  if (slot === 'tomorrow') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(20, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

/** Mirrors supabase/functions/_shared/fcm-cleanup.ts deleteStaleToken */
export async function deleteStaleToken(token: string): Promise<void> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/user_devices?fcm_token=eq.${encodeURIComponent(token)}`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
  );
  if (!res.ok) {
    const errText = await res.text();
    console.error('deleteStaleToken failed', res.status, errText);
  }
}

export async function invokeExpirePendingOrders(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('expire_pending_orders');
  if (error) throw error;
}

export async function invokeWarnPendingOrdersNearDeadline(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('warn_pending_orders_near_deadline');
  if (error) throw error;
}

export async function invokeWarnNearDeadlinePush(): Promise<{ pushed: number }> {
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const res = await fetch(`${supabaseUrl}/functions/v1/warn-near-deadline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const json = (await res.json().catch(() => ({}))) as { pushed?: number };
  return { pushed: json.pushed ?? 0 };
}

export async function invokeAnonymiseDeletedAccounts(): Promise<void> {
  const { error } = await supabaseAdmin.rpc('anonymise_deleted_accounts');
  if (error) throw error;
}

export async function postDeleteAccount(
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
  const res = await fetch(`${supabaseUrl}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: json };
}

export function uniqueTestPhone(prefix = '88001'): string {
  return `${prefix}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10)}`;
}

/** 10-digit Indian mobile for browser phone-entry UI (maxLength 10). */
export function uniqueBrowserPhone(prefix: string): string {
  return `${prefix}${Date.now().toString().slice(-6)}`.slice(0, 10);
}

export async function createModeVendor(
  serviceMode: 'help' | 'delivery' | 'appointment',
  phone: string,
) {
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      name: `Vendor ${serviceMode} ${TEST_SESSION}`,
      shop_name: `Shop ${serviceMode}`,
      phone,
      category: 'Grocery',
      service_mode: serviceMode,
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `test_session:${TEST_SESSION}`,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function cleanupSession38Data(customerPhones: string[] = []) {
  const phones = [...new Set([...customerPhones])];
  for (const phone of phones) {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_addresses').delete().eq('user_phone', phone);
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  await supabaseAdmin.from('users').delete().like('phone', 'deleted_%');
  await supabaseAdmin.from('requests').delete().like('user_phone', 'deleted_%');
}

/** Phone/device cleanup for browser specs — does not remove shared session vendors. */
export async function cleanupBrowserSession38Data(
  phones: string[] = [],
  deviceIds: string[] = [],
) {
  for (const deviceId of deviceIds) {
    await supabaseAdmin.from('requests').delete().eq('device_id', deviceId);
  }
  for (const phone of [...new Set(phones)]) {
    await supabaseAdmin.from('user_notifications').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_devices').delete().eq('user_phone', phone);
    await supabaseAdmin.from('user_addresses').delete().eq('user_phone', phone);
    await supabaseAdmin.from('app_users').delete().eq('phone', phone);
    await supabaseAdmin.from('requests').delete().eq('user_phone', phone);
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  await supabaseAdmin.from('users').delete().like('phone', 'deleted_%');
  await supabaseAdmin.from('requests').delete().like('user_phone', 'deleted_%');
}

export function slotDeadlineAtLocal(hour: number, dayOffset = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}
