/**
 * Admin support-ticket list/resolve + customer phone lookup RPCs.
 * Requires an authenticated admin session (is_admin_session).
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { ensureTestAdminUser, getAdminSessionClient } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from './helpers/setup';

const T = Date.now();
let seq = 0;
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdRequestIds: string[] = [];
const createdSupportIds: string[] = [];
const createdAuthUserIds: string[] = [];
const createdDisputeIds: string[] = [];

function nextPhone(prefix: '990' | '880'): string {
  seq += 1;
  return `${prefix}61${String(T + seq).slice(-5)}`;
}

async function seedVendor(tag: string): Promise<{ id: string; phone: string; shopName: string }> {
  const phone = nextPhone('990');
  const category = await getActiveCategoryByServiceMode('delivery');
  const shopName = `!ASL-${tag}-${T}`;
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: `Owner ${tag}`,
      shop_name: shopName,
      phone,
      category: category.label,
      service_mode: category.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(data!.id, category, { modes: ['help', 'delivery'] });
  createdVendorIds.push(data!.id);
  createdPhones.push(phone);
  return { id: data!.id, phone: data!.phone, shopName: data!.shop_name };
}

async function seedCustomer(tag: string): Promise<string> {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert(
    {
      phone,
      trust_score: 72,
      is_banned: tag === 'banned',
      ban_reason: tag === 'banned' ? 'test ban' : null,
      deletion_requested_at: tag === 'deleting' ? new Date().toISOString() : null,
    },
    { onConflict: 'phone' },
  );
  createdPhones.push(phone);
  return phone;
}

let adminClient: Awaited<ReturnType<typeof getAdminSessionClient>>;

test.beforeAll(async () => {
  await ensureTestAdminUser();
  adminClient = await getAdminSessionClient();
});

test.afterAll(async () => {
  if (createdDisputeIds.length) {
    await supabaseAdmin.from('payment_dispute_events').delete().in('id', createdDisputeIds);
  }
  if (createdSupportIds.length) {
    await supabaseAdmin.from('support_messages').delete().in('id', createdSupportIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('khata_ledger').delete().in('user_phone', createdPhones);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  } else if (createdPhones.length) {
    await supabaseAdmin.from('khata_ledger').delete().in('user_phone', createdPhones);
  }
  for (const id of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
});

test('ASL-01 — non-admin cannot list/resolve/lookup; admin SELECT policy is session-gated', async () => {
  const email = `asl.nonadmin.${T}@aaspaas.invalid`;
  const password = `asl_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  if (created?.user?.id) createdAuthUserIds.push(created.user.id);

  const nonAdmin = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInErr } = await nonAdmin.auth.signInWithPassword({ email, password });
  expect(signInErr, signInErr?.message).toBeNull();

  const { error: listErr } = await nonAdmin.rpc('admin_list_support_messages', {
    p_include_resolved: false,
  });
  expect(listErr, 'non-admin list must be rejected').not.toBeNull();
  expect(listErr!.message).toContain('unauthorized');

  const { error: resolveErr } = await nonAdmin.rpc('admin_resolve_support_message', {
    p_id: '00000000-0000-0000-0000-000000000001',
  });
  expect(resolveErr, 'non-admin resolve must be rejected').not.toBeNull();
  expect(resolveErr!.message).toContain('unauthorized');

  const { error: lookupErr } = await nonAdmin.rpc('admin_lookup_customer', {
    p_phone: '8800088001',
  });
  expect(lookupErr, 'non-admin lookup must be rejected').not.toBeNull();
  expect(lookupErr!.message).toContain('unauthorized');

  const { data: directRows, error: directErr } = await nonAdmin
    .from('support_messages')
    .select('id')
    .limit(1);
  expect(directErr, directErr?.message).toBeNull();
  expect(directRows ?? []).toEqual([]);
});

test('ASL-02 — anon cannot execute the new admin RPCs', async () => {
  const { error: listErr } = await supabase.rpc('admin_list_support_messages');
  expect(listErr, 'anon list must fail').not.toBeNull();

  const { error: lookupErr } = await supabase.rpc('admin_lookup_customer', {
    p_phone: '8800088001',
  });
  expect(lookupErr, 'anon lookup must fail').not.toBeNull();
});

test('ASL-03 — admin lists open tickets, resolves one, and hides it unless include-resolved', async () => {
  const phone = await seedCustomer('ticket');
  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('support_messages')
    .insert({
      kind: 'contact',
      category: 'order',
      message: `ASL ticket ${T}`,
      user_phone: phone,
      email_sent: true,
    })
    .select('id')
    .single();
  expect(insertErr, insertErr?.message).toBeNull();
  createdSupportIds.push(inserted!.id);

  const { data: openRows, error: openErr } = await adminClient.rpc('admin_list_support_messages', {
    p_include_resolved: false,
  });
  expect(openErr, openErr?.message).toBeNull();
  const open = (openRows as { id: string; message: string; resolved_at: string | null }[] | null) ?? [];
  expect(open.some((row) => row.id === inserted!.id)).toBe(true);

  const { data: viaSelect } = await adminClient
    .from('support_messages')
    .select('id, message, user_phone')
    .eq('id', inserted!.id)
    .maybeSingle();
  expect(viaSelect?.id).toBe(inserted!.id);
  expect(viaSelect?.user_phone).toBe(phone);

  const { error: resolveErr } = await adminClient.rpc('admin_resolve_support_message', {
    p_id: inserted!.id,
  });
  expect(resolveErr, resolveErr?.message).toBeNull();

  const { error: againErr } = await adminClient.rpc('admin_resolve_support_message', {
    p_id: inserted!.id,
  });
  expect(againErr, 'second resolve must be idempotent').toBeNull();

  const { data: afterOpen, error: afterOpenErr } = await adminClient.rpc(
    'admin_list_support_messages',
    { p_include_resolved: false },
  );
  expect(afterOpenErr, afterOpenErr?.message).toBeNull();
  const stillOpen =
    (afterOpen as { id: string }[] | null)?.some((row) => row.id === inserted!.id) ?? false;
  expect(stillOpen).toBe(false);

  const { data: withResolved, error: withResolvedErr } = await adminClient.rpc(
    'admin_list_support_messages',
    { p_include_resolved: true },
  );
  expect(withResolvedErr, withResolvedErr?.message).toBeNull();
  const resolvedRow = (
    (withResolved as { id: string; resolved_at: string | null }[] | null) ?? []
  ).find((row) => row.id === inserted!.id);
  expect(resolvedRow?.resolved_at).toBeTruthy();

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('action_type, target_id')
    .eq('action_type', 'resolve_support_message')
    .eq('target_id', inserted!.id)
    .limit(1);
  expect(audit?.length).toBe(1);
});

test('ASL-04 — admin customer lookup returns flags, orders, disputes, and Khata', async () => {
  const vendor = await seedVendor('lookup');
  const phone = await seedCustomer('lookup');

  const { data: order, error: orderErr } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendor.id,
      user_phone: phone,
      device_id: `asl_dev_${T}`,
      message: `ASL lookup order ${T}`,
      status: 'accepted',
      payment_status: 'disputed',
      service_mode: 'help',
    })
    .select('id')
    .single();
  expect(orderErr, orderErr?.message).toBeNull();
  createdRequestIds.push(order!.id);

  const { data: dispute, error: disputeErr } = await supabaseAdmin
    .from('payment_dispute_events')
    .insert({
      request_id: order!.id,
      vendor_id: vendor.id,
      user_phone: phone,
      device_id: `asl_dev_${T}`,
    })
    .select('id')
    .single();
  expect(disputeErr, disputeErr?.message).toBeNull();
  createdDisputeIds.push(dispute!.id);

  const { error: khataErr } = await supabaseAdmin.from('khata_ledger').insert({
    vendor_id: vendor.id,
    user_phone: phone,
    total_outstanding: 150,
  });
  expect(khataErr, khataErr?.message).toBeNull();

  const { data, error } = await adminClient.rpc('admin_lookup_customer', {
    p_phone: `+91 ${phone}`,
  });
  expect(error, error?.message).toBeNull();
  const payload = data as {
    found: boolean;
    phone: string;
    user: { is_banned: boolean; trust_score: number };
    orders: { id: string; payment_status: string }[];
    disputes: { request_id: string }[];
    khata: { total_outstanding: number; vendor_shop_name: string | null }[];
  };
  expect(payload.found).toBe(true);
  expect(payload.phone).toBe(phone);
  expect(payload.user?.trust_score).toBe(72);
  expect(payload.orders.some((row) => row.id === order!.id && row.payment_status === 'disputed')).toBe(
    true,
  );
  expect(payload.disputes.some((row) => row.request_id === order!.id)).toBe(true);
  expect(payload.khata.some((row) => Number(row.total_outstanding) === 150)).toBe(true);

  const { error: badPhoneErr } = await adminClient.rpc('admin_lookup_customer', {
    p_phone: '123',
  });
  expect(badPhoneErr, 'invalid phone must be rejected').not.toBeNull();
  expect(badPhoneErr!.message).toContain('invalid_phone_format');

  const missingPhone = nextPhone('880');
  const { data: missing, error: missingErr } = await adminClient.rpc('admin_lookup_customer', {
    p_phone: missingPhone,
  });
  expect(missingErr, missingErr?.message).toBeNull();
  expect((missing as { found: boolean }).found).toBe(false);
});
