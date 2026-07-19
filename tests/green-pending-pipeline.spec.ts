import { test, expect } from '@playwright/test';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
} from './helpers/setup';
import { ensureTestAdminUser, getAdminSessionClient } from './helpers/browser-setup';

// Green-Pending pipeline hardening (migration 20260719100001):
// 1. vendor_update_own: verification_status is field_not_allowed; phone/UPI
//    change auto-downgrades to identity_linked server-side.
// 2. vendor_promote_green_pending / vendor_promote_category_green_pending:
//    selfie (vendors.photo_selfie) required.
// 3. admin_verify_vendor / admin_verify_vendor_category: reject vendors /
//    businesses not at green_pending or business_verified.
// 4. get_admin_green_pending_stats: admin-gated ready-for-review counts.
// `supabase` = anon key, NO auth session (real production identity).

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

const GREEN_READY_FIELDS = {
  verification_status: 'business_verified',
  shop_photo_url: 'https://example.com/shop.jpg',
  photo_selfie: 'https://example.com/selfie.jpg',
  upi_verified: true,
  is_manual_verified: false,
};

async function seedVendor(shopName: string, fields: Record<string, unknown> = {}) {
  const cat = await getActiveCategoryByLabel('Pharmacy');
  const vendorPhone = nextPhone('99093');
  const { data, error } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Green Pipeline',
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
  return { id: data.id as string, phone: data.phone as string, categoryId: cat.id };
}

async function vendorStatus(vendorId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('vendors')
    .select('verification_status')
    .eq('id', vendorId)
    .single();
  return data?.verification_status ?? null;
}

async function categoryRow(vendorId: string, categoryId: string) {
  const { data } = await supabaseAdmin
    .from('vendor_categories')
    .select('verification_status, is_manual_verified')
    .eq('vendor_id', vendorId)
    .eq('category_id', categoryId)
    .single();
  return data;
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
});

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from('vendor_category_modes').delete().in(
      'vendor_category_id',
      (
        await supabaseAdmin.from('vendor_categories').select('id').eq('vendor_id', id)
      ).data?.map((r) => r.id) ?? [],
    );
    await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', id);
    await supabaseAdmin.from('vendors').delete().eq('id', id);
  }
  for (const phone of createdPhones) {
    await supabaseAdmin.from('users').delete().eq('phone', phone);
  }
});

test('GP-01 — vendor_update_own rejects verification_status (field_not_allowed); status unchanged', async () => {
  const vendor = await seedVendor(`!GP01-${T}`, { verification_status: 'identity_linked' });

  const { error } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { verification_status: 'green_pending' },
  });
  expect(error?.message ?? '').toContain('field_not_allowed');
  expect(await vendorStatus(vendor.id)).toBe('identity_linked');

  // Business-as-usual patches still work.
  const { error: okErr } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { vendor_note: `gp01-${T}` },
  });
  expect(okErr, okErr?.message).toBeNull();
});

test('GP-02 — phone/UPI change downgrades verification_status to identity_linked server-side', async () => {
  const vendor = await seedVendor(`!GP02-${T}`, {
    ...GREEN_READY_FIELDS,
    upi_id: 'gp02@upi',
  });

  // UPI change → identity_linked (the client no longer sends the field).
  const { error: upiErr } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { upi_id: 'gp02-changed@upi' },
  });
  expect(upiErr, upiErr?.message).toBeNull();
  expect(await vendorStatus(vendor.id)).toBe('identity_linked');

  // Reset, then phone change → identity_linked too.
  await supabaseAdmin
    .from('vendors')
    .update({ verification_status: 'business_verified' })
    .eq('id', vendor.id);
  const newPhone = nextPhone('99094');
  const { error: phoneErr } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_patch: { phone: newPhone },
  });
  expect(phoneErr, phoneErr?.message).toBeNull();
  expect(await vendorStatus(vendor.id)).toBe('identity_linked');

  // Unrelated patch does NOT downgrade.
  await supabaseAdmin
    .from('vendors')
    .update({ verification_status: 'business_verified' })
    .eq('id', vendor.id);
  const { error: noteErr } = await supabase.rpc('vendor_update_own', {
    p_vendor_id: vendor.id,
    p_vendor_phone: newPhone,
    p_patch: { vendor_note: `gp02-${T}`, upi_id: 'gp02-changed@upi' },
  });
  expect(noteErr, noteErr?.message).toBeNull();
  expect(await vendorStatus(vendor.id)).toBe('business_verified');
});

test('GP-03 — vendor_promote_green_pending requires selfie', async () => {
  // UPI + photo + business_verified but NO selfie → not promoted.
  const noSelfie = await seedVendor(`!GP03-noselfie-${T}`, {
    ...GREEN_READY_FIELDS,
    photo_selfie: null,
  });
  const { data: notPromoted, error: nErr } = await supabase.rpc(
    'vendor_promote_green_pending',
    { p_vendor_id: noSelfie.id, p_vendor_phone: noSelfie.phone },
  );
  expect(nErr, nErr?.message).toBeNull();
  expect(notPromoted).toBe(false);
  expect(await vendorStatus(noSelfie.id)).toBe('business_verified');

  // Same vendor with selfie → promoted.
  await supabaseAdmin
    .from('vendors')
    .update({ photo_selfie: 'https://example.com/selfie.jpg' })
    .eq('id', noSelfie.id);
  const { data: promoted, error: pErr } = await supabase.rpc('vendor_promote_green_pending', {
    p_vendor_id: noSelfie.id,
    p_vendor_phone: noSelfie.phone,
  });
  expect(pErr, pErr?.message).toBeNull();
  expect(promoted).toBe(true);
  expect(await vendorStatus(noSelfie.id)).toBe('green_pending');

  // Idempotent: second call is a no-op (already green_pending).
  const { data: again } = await supabase.rpc('vendor_promote_green_pending', {
    p_vendor_id: noSelfie.id,
    p_vendor_phone: noSelfie.phone,
  });
  expect(again).toBe(false);
});

test('GP-04 — vendor_promote_category_green_pending requires selfie; returns promotion outcome', async () => {
  const vendor = await seedVendor(`!GP04-${T}`, {
    ...GREEN_READY_FIELDS,
    photo_selfie: null,
  });
  await supabaseAdmin
    .from('vendor_categories')
    .update({
      shop_photo_url: 'https://example.com/shop.jpg',
      verification_status: 'business_verified',
      is_manual_verified: false,
    })
    .eq('vendor_id', vendor.id)
    .eq('category_id', vendor.categoryId);

  // No selfie → not promoted.
  const { data: notPromoted, error: nErr } = await supabase.rpc(
    'vendor_promote_category_green_pending',
    {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_category_id: vendor.categoryId,
    },
  );
  expect(nErr, nErr?.message).toBeNull();
  expect(notPromoted).toBe(false);
  expect((await categoryRow(vendor.id, vendor.categoryId))?.verification_status).toBe(
    'business_verified',
  );

  // With selfie → promoted, returns true.
  await supabaseAdmin
    .from('vendors')
    .update({ photo_selfie: 'https://example.com/selfie.jpg' })
    .eq('id', vendor.id);
  const { data: promoted, error: pErr } = await supabase.rpc(
    'vendor_promote_category_green_pending',
    {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendor.phone,
      p_category_id: vendor.categoryId,
    },
  );
  expect(pErr, pErr?.message).toBeNull();
  expect(promoted).toBe(true);
  expect((await categoryRow(vendor.id, vendor.categoryId))?.verification_status).toBe(
    'green_pending',
  );
});

test('GP-05 — admin_verify_vendor_category rejects a business not at green_pending/business_verified', async () => {
  const vendor = await seedVendor(`!GP05-${T}`, { verification_status: 'identity_linked' });
  await supabaseAdmin
    .from('vendor_categories')
    .update({ verification_status: 'identity_linked', is_manual_verified: false })
    .eq('vendor_id', vendor.id)
    .eq('category_id', vendor.categoryId);

  const adminClient = await getAdminSessionClient();

  // Not ready → rejected.
  const { error: notReadyErr } = await adminClient.rpc('admin_verify_vendor_category', {
    p_admin_phone: 'gp-test-admin',
    p_vendor_id: vendor.id,
    p_category_id: vendor.categoryId,
  });
  expect(notReadyErr?.message ?? '').toContain('category_not_ready');
  expect((await categoryRow(vendor.id, vendor.categoryId))?.is_manual_verified).toBe(false);

  // green_pending → approved.
  await supabaseAdmin
    .from('vendor_categories')
    .update({ verification_status: 'green_pending' })
    .eq('vendor_id', vendor.id)
    .eq('category_id', vendor.categoryId);
  const { error: okErr } = await adminClient.rpc('admin_verify_vendor_category', {
    p_admin_phone: 'gp-test-admin',
    p_vendor_id: vendor.id,
    p_category_id: vendor.categoryId,
  });
  expect(okErr, okErr?.message).toBeNull();
  expect((await categoryRow(vendor.id, vendor.categoryId))?.is_manual_verified).toBe(true);
  const { data: acc } = await supabaseAdmin
    .from('vendors')
    .select('is_manual_verified')
    .eq('id', vendor.id)
    .single();
  expect(acc?.is_manual_verified).toBe(true);
});

test('GP-06 — admin_verify_vendor (account-level) rejects a vendor not at green_pending/business_verified', async () => {
  const vendor = await seedVendor(`!GP06-${T}`, { verification_status: 'identity_linked' });
  const adminClient = await getAdminSessionClient();

  const { error: notReadyErr } = await adminClient.rpc('admin_verify_vendor', {
    p_admin_phone: 'gp-test-admin',
    p_vendor_id: vendor.id,
  });
  expect(notReadyErr?.message ?? '').toContain('vendor_not_ready');
  const { data: before } = await supabaseAdmin
    .from('vendors')
    .select('is_manual_verified')
    .eq('id', vendor.id)
    .single();
  expect(before?.is_manual_verified).toBe(false);

  await supabaseAdmin
    .from('vendors')
    .update({ verification_status: 'green_pending' })
    .eq('id', vendor.id);
  const { error: okErr } = await adminClient.rpc('admin_verify_vendor', {
    p_admin_phone: 'gp-test-admin',
    p_vendor_id: vendor.id,
  });
  expect(okErr, okErr?.message).toBeNull();
  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('is_manual_verified')
    .eq('id', vendor.id)
    .single();
  expect(after?.is_manual_verified).toBe(true);
});

test('GP-07 — get_admin_green_pending_stats: anon rejected; admin sees ready-for-review counts', async () => {
  const vendor = await seedVendor(`!GP07-${T}`, {
    ...GREEN_READY_FIELDS,
    verification_status: 'green_pending',
  });

  const { error: anonErr } = await supabase.rpc('get_admin_green_pending_stats');
  // 20260719120001 revoked anon EXECUTE, so rejection may occur at the grant layer before the internal check.
  expect(anonErr).not.toBeNull();
  expect(anonErr?.message ?? '').toMatch(/not_authorized|permission denied/i);

  const adminClient = await getAdminSessionClient();
  const { data, error } = await adminClient.rpc('get_admin_green_pending_stats');
  expect(error, error?.message).toBeNull();
  const stats = data as {
    account_pending: number;
    category_pending: number;
    vendors_ready: number;
  };
  expect(stats.account_pending).toBeGreaterThanOrEqual(1);
  expect(stats.vendors_ready).toBeGreaterThanOrEqual(1);

  // Keep TypeScript happy about usage; the seeded vendor is cleaned in afterAll.
  expect(vendor.id).toBeTruthy();
});
