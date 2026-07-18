import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';

// Vendor settings/stats/location read hardening (OTP-off identity model).
// Follow-up to vendor-read-hardening: covers get_vendor_blocking_active_orders,
// get_vendor_order_stats_rows, get_vendor_accepted_orders,
// get_vendor_khata_has_outstanding, get_vendor_credits,
// get_vendor_deletion_status, and the server-side green-criteria checks folded
// into vendor_promote_green_pending.
// `supabase` = anon key, NO auth session (real production identity).

const T = Date.now();
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdPhones: string[] = [];
const rlIdentifiers: string[] = [];
const RL_ACTIONS = [
  'get_vendor_blocking_active_orders',
  'get_vendor_order_stats_rows',
  'get_vendor_accepted_orders',
  'get_vendor_khata_has_outstanding',
  'get_vendor_credits',
  'get_vendor_deletion_status',
];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  rlIdentifiers.push(phone);
  return phone;
}

async function seedVendor(shopName: string, fields: Record<string, unknown> = {}) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const vendorPhone = nextPhone('99091');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Settings Read Hardening',
      shop_name: shopName,
      phone: vendorPhone,
      category: cat.label,
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: 'complete',
      service_radius_km: 15,
      ...fields,
    })
    .select('id, phone')
    .single();
  if (error) throw error;
  createdVendorIds.push(data.id);
  await seedVendorCategory(data.id, cat, { is_primary: true });
  return { id: data.id as string, phone: data.phone as string };
}

async function seedRequest(
  vendorId: string,
  userPhone: string | null,
  fields: Record<string, unknown> = {},
) {
  const { data, error } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: vendorId,
      user_phone: userPhone,
      device_id: `devVSR_${T}_${createdRequestIds.length}`,
      message: `vendor-settings-read-${T}-${createdRequestIds.length}`,
      status: 'sent',
      ...fields,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

test.afterAll(async () => {
  for (const id of createdRequestIds) {
    await supabaseAdmin.from('requests').delete().eq('id', id);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_credits').delete().eq('vendor_id', id);
    await supabaseAdmin.from('khata_ledger').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
  if (rlIdentifiers.length > 0) {
    for (const action of RL_ACTIONS) {
      await supabaseAdmin
        .from('edge_function_rate_limits')
        .delete()
        .eq('function_name', action)
        .in('identifier', rlIdentifiers);
    }
  }
});

test('VSR-01 — get_vendor_blocking_active_orders: active statuses only; direct read blocked; wrong identity rejected', async () => {
  const vendor = await seedVendor(`!VSR01-${T}`);
  const custPhone = nextPhone('88091');

  const sentId = await seedRequest(vendor.id, custPhone, { status: 'sent' });
  const acceptedId = await seedRequest(vendor.id, custPhone, { status: 'accepted' });
  const doneId = await seedRequest(vendor.id, custPhone, { status: 'done' });
  const expiredId = await seedRequest(vendor.id, custPhone, { status: 'expired' });

  const direct = await supabase.from('requests').select('id').eq('vendor_id', vendor.id);
  expect(direct.error).toBeNull();
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_vendor_blocking_active_orders', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(error, error?.message).toBeNull();
  const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id).sort();
  expect(ids).toEqual([sentId, acceptedId].sort());
  expect(ids).not.toContain(doneId);
  expect(ids).not.toContain(expiredId);

  const { error: wrongErr } = await supabase.rpc('get_vendor_blocking_active_orders', {
    p_vendor_id: vendor.id,
    p_vendor_phone: nextPhone('99092'),
  });
  expect(wrongErr?.message ?? '').toMatch(/not_found_or_unauthorized|identity_required/);
});

test('VSR-02 — get_vendor_order_stats_rows returns all rows incl. terminal; get_vendor_accepted_orders only accepted', async () => {
  const vendor = await seedVendor(`!VSR02-${T}`);
  const custPhone = nextPhone('88092');

  await seedRequest(vendor.id, custPhone, { status: 'sent' });
  const acceptedId = await seedRequest(vendor.id, custPhone, { status: 'accepted' });
  await seedRequest(vendor.id, custPhone, { status: 'done' });
  await seedRequest(vendor.id, custPhone, { status: 'expired' });

  const { data: statsRows, error: statsErr } = await supabase.rpc(
    'get_vendor_order_stats_rows',
    { p_vendor_id: vendor.id, p_vendor_phone: vendor.phone },
  );
  expect(statsErr, statsErr?.message).toBeNull();
  expect((statsRows ?? []).length).toBe(4);
  const statuses = ((statsRows ?? []) as Array<{ status: string }>).map((r) => r.status).sort();
  expect(statuses).toEqual(['accepted', 'done', 'expired', 'sent']);

  const { data: accepted, error: accErr } = await supabase.rpc('get_vendor_accepted_orders', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(accErr, accErr?.message).toBeNull();
  expect(((accepted ?? []) as Array<{ id: string }>).map((r) => r.id)).toEqual([acceptedId]);
});

test('VSR-03 — get_vendor_khata_has_outstanding true/false; direct khata read blocked', async () => {
  const vendor = await seedVendor(`!VSR03-${T}`);
  const custPhone = nextPhone('88093');

  const { data: before, error: beforeErr } = await supabase.rpc(
    'get_vendor_khata_has_outstanding',
    { p_vendor_id: vendor.id, p_vendor_phone: vendor.phone },
  );
  expect(beforeErr, beforeErr?.message).toBeNull();
  expect(before).toBe(false);

  await supabaseAdmin.from('khata_ledger').insert({
    vendor_id: vendor.id,
    user_phone: custPhone,
    total_outstanding: 120,
  });

  const direct = await supabase.from('khata_ledger').select('id').eq('vendor_id', vendor.id);
  expect(direct.data).toEqual([]);

  const { data: after } = await supabase.rpc('get_vendor_khata_has_outstanding', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(after).toBe(true);
});

test('VSR-04 — get_vendor_credits returns own credits; direct read blocked; other vendor sees nothing', async () => {
  const vendor = await seedVendor(`!VSR04-${T}`);
  const otherVendor = await seedVendor(`!VSR04-other-${T}`);

  const { error: insErr } = await supabaseAdmin.from('vendor_credits').insert([
    { vendor_id: vendor.id, amount: 100, disbursed: false, disbursement_month: 1 },
    { vendor_id: vendor.id, amount: 50, disbursed: true, disbursement_month: 2 },
  ]);
  expect(insErr).toBeNull();

  const direct = await supabase.from('vendor_credits').select('amount').eq('vendor_id', vendor.id);
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_vendor_credits', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{ amount: number; disbursed: boolean }>;
  expect(rows.length).toBe(2);
  const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  const pending = rows.filter((r) => !r.disbursed).reduce((sum, r) => sum + Number(r.amount), 0);
  expect(total).toBe(150);
  expect(pending).toBe(100);

  const { data: otherRows } = await supabase.rpc('get_vendor_credits', {
    p_vendor_id: otherVendor.id,
    p_vendor_phone: otherVendor.phone,
  });
  expect(otherRows ?? []).toEqual([]);
});

test('VSR-05 — get_vendor_deletion_status works for hidden vendors; empty for unknown phone', async () => {
  // Hidden vendor: invisible to the public vendors read policy.
  const vendor = await seedVendor(`!VSR05-${T}`, {
    discoverable: false,
    deletion_requested_at: new Date('2026-07-01T00:00:00Z').toISOString(),
  });

  // Direct read (public policy) can't see a hidden vendor.
  const direct = await supabase.from('vendors').select('id').eq('phone', vendor.phone);
  expect(direct.data).toEqual([]);

  const { data, error } = await supabase.rpc('get_vendor_deletion_status', {
    p_phone: vendor.phone,
  });
  expect(error, error?.message).toBeNull();
  const rows = (data ?? []) as Array<{ vendor_id: string; deletion_requested_at: string | null }>;
  expect(rows.length).toBe(1);
  expect(rows[0].vendor_id).toBe(vendor.id);
  expect(rows[0].deletion_requested_at).toContain('2026-07-01');

  const { data: unknown } = await supabase.rpc('get_vendor_deletion_status', {
    p_phone: nextPhone('88094'),
  });
  expect(unknown ?? []).toEqual([]);

  const { error: noIdErr } = await supabase.rpc('get_vendor_deletion_status', { p_phone: '' });
  expect(noIdErr?.message ?? '').toContain('identity_required');
});

test('VSR-06 — vendor_promote_green_pending enforces criteria server-side', async () => {
  // Meets everything → promoted (even while hidden, since the old client
  // pre-read is gone).
  const ready = await seedVendor(`!VSR06-ready-${T}`, {
    discoverable: false,
    verification_status: 'business_verified',
    shop_photo_url: 'https://example.com/shop.jpg',
    upi_verified: true,
    is_manual_verified: false,
  });
  const { data: promoted, error: pErr } = await supabase.rpc('vendor_promote_green_pending', {
    p_vendor_id: ready.id,
  });
  expect(pErr, pErr?.message).toBeNull();
  expect(promoted).toBe(true);
  const { data: readyRow } = await supabaseAdmin
    .from('vendors')
    .select('verification_status')
    .eq('id', ready.id)
    .single();
  expect(readyRow?.verification_status).toBe('green_pending');

  // Wrong status (not business_verified) → not promoted, even with photo+UPI.
  const notVerified = await seedVendor(`!VSR06-notv-${T}`, {
    verification_status: 'unverified',
    shop_photo_url: 'https://example.com/shop.jpg',
    upi_verified: true,
    is_manual_verified: false,
  });
  const { data: notPromoted } = await supabase.rpc('vendor_promote_green_pending', {
    p_vendor_id: notVerified.id,
  });
  expect(notPromoted).toBe(false);
  const { data: nvRow } = await supabaseAdmin
    .from('vendors')
    .select('verification_status')
    .eq('id', notVerified.id)
    .single();
  expect(nvRow?.verification_status).toBe('unverified');
});

test('VSR-07 — get_vendor_credits rate limit: 31st call rejected', async () => {
  const vendor = await seedVendor(`!VSR07-${T}`);
  let rateLimited = false;
  for (let i = 0; i < 31; i += 1) {
    const { error } = await supabase.rpc('get_vendor_credits', {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
    });
    if (error?.message.includes('rate_limited')) {
      rateLimited = true;
      expect(i).toBeGreaterThanOrEqual(30);
      break;
    }
    expect(error, error?.message).toBeNull();
  }
  expect(rateLimited).toBe(true);
});
