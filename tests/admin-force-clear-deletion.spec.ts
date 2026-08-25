/**
 * admin_force_clear_deletion: session-gated override of vendors.deletion_requested_at.
 * Covers unauthorized rejection, admin clear + audit, and immediate restore /
 * discoverability (Defect #10 radar/booking gate).
 */
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import {
  ensureTestAdminUser,
  getAdminSessionClient,
  loginAsAdminViaSession,
} from './helpers/browser-setup';
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
const createdAuthUserIds: string[] = [];
const DEVICE_ID = `device_afcd_${T}`;

function nextPhone(prefix: '990' | '880'): string {
  seq += 1;
  return `${prefix}51${String(T + seq).slice(-5)}`;
}

async function seedScheduledDeletionVendor(tag: string): Promise<{
  id: string;
  phone: string;
  shopName: string;
  categoryId: string;
  mode: string;
}> {
  const phone = nextPhone('990');
  const category = await getActiveCategoryByServiceMode('delivery');
  const shopName = `!000-afcd-${tag}-${T}`;
  const requestedAt = new Date().toISOString();
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
      discoverable: true,
      profile_status: 'complete',
      service_radius_km: 15,
      shop_photo_url: 'https://example.com/shop.jpg',
      photo_selfie: 'https://example.com/selfie.jpg',
      verification_status: 'identity_linked',
      is_manual_verified: false,
      deletion_requested_at: requestedAt,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  await seedVendorCategory(data!.id, category, { modes: ['help', 'delivery'] });
  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: requestedAt },
    { onConflict: 'phone' },
  );
  createdVendorIds.push(data!.id);
  createdPhones.push(phone);
  return {
    id: data!.id,
    phone: data!.phone,
    shopName: data!.shop_name,
    categoryId: category.id,
    mode: String(category.service_mode ?? 'delivery').toLowerCase(),
  };
}

let adminClient: Awaited<ReturnType<typeof getAdminSessionClient>>;

test.beforeAll(async () => {
  await ensureTestAdminUser();
  adminClient = await getAdminSessionClient();
});

test.afterAll(async () => {
  for (const id of createdAuthUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(id);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin
      .from('edge_function_rate_limits')
      .delete()
      .in('function_name', ['get_vendor_restore_status'])
      .in('identifier', createdPhones);
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
});

test('AFCD-01 — non-admin session is rejected; flag unchanged', async () => {
  const vendor = await seedScheduledDeletionVendor('unauth');
  const email = `afcd.nonadmin.${T}@aaspaas.invalid`;
  const password = `afcd_pw_${T}`;
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

  const { data, error } = await nonAdmin.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendor.id,
    p_notes: 'should not work',
  });
  expect(error, 'non-admin authenticated session must be rejected').not.toBeNull();
  expect(error!.message).toContain('unauthorized');
  expect(data ?? null).toBeNull();

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('id', vendor.id)
    .single();
  expect(row?.deletion_requested_at).not.toBeNull();
});

test('AFCD-02 — anon cannot execute; empty notes rejected; admin clears vendors+users and audits', async () => {
  const vendor = await seedScheduledDeletionVendor('clear');

  const { data: anonData, error: anonErr } = await supabase.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendor.id,
    p_notes: 'anon attempt',
  });
  expect(anonErr, 'anon must not execute admin_force_clear_deletion').not.toBeNull();
  expect(anonData ?? null).toBeNull();

  const { error: emptyErr } = await adminClient.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendor.id,
    p_notes: '   ',
  });
  expect(emptyErr, 'empty notes must be rejected').not.toBeNull();
  expect(emptyErr!.message).toContain('reason_required');

  const reason = `TEST force-clear ${T}`;
  const { error } = await adminClient.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendor.id,
    p_notes: reason,
  });
  expect(error, error?.message).toBeNull();

  const { data: vendorRow } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('id', vendor.id)
    .single();
  expect(vendorRow?.deletion_requested_at).toBeNull();

  const { data: userRow } = await supabaseAdmin
    .from('users')
    .select('deletion_requested_at')
    .eq('phone', vendor.phone)
    .single();
  expect(userRow?.deletion_requested_at).toBeNull();

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('action_type, target_type, target_id, reason, admin_phone')
    .eq('target_id', vendor.id)
    .eq('action_type', 'force_clear_deletion')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  expect(audit?.target_type).toBe('vendor');
  expect(audit?.reason).toBe(reason);
  expect((audit?.admin_phone ?? '').length).toBeGreaterThan(0);

  const { error: againErr } = await adminClient.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendor.id,
    p_notes: 'second clear',
  });
  expect(againErr, 'already-cleared vendor must be rejected').not.toBeNull();
  expect(againErr!.message).toContain('no_deletion_pending');
});

test('AFCD-03 — after force-clear, restore status and discoverability return immediately', async () => {
  const phone = nextPhone('990');
  const customerPhone = nextPhone('880');
  const category = await getActiveCategoryByServiceMode('delivery');
  const mode = String(category.service_mode ?? 'delivery').toLowerCase();
  createdPhones.push(phone, customerPhone);

  const { data: vendor, error: insErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Owner restore',
      shop_name: `!000-afcd-restore-${T}`,
      phone,
      category: category.label,
      service_mode: category.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      discoverable: true,
      profile_status: 'complete',
      service_radius_km: 15,
      shop_photo_url: 'https://example.com/shop.jpg',
      photo_selfie: 'https://example.com/selfie.jpg',
      verification_status: 'identity_linked',
      deletion_requested_at: null,
    })
    .select('id')
    .single();
  expect(insErr, insErr?.message).toBeNull();
  const vendorId = vendor!.id;
  createdVendorIds.push(vendorId);
  await seedVendorCategory(vendorId, category, { modes: ['help', 'delivery'] });
  await supabaseAdmin.from('users').upsert(
    { phone, trust_score: 75, deletion_requested_at: null },
    { onConflict: 'phone' },
  );
  await supabaseAdmin.from('users').upsert(
    { phone: customerPhone, trust_score: 75 },
    { onConflict: 'phone' },
  );

  const { data: onRadar, error: onRadarErr } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: mode,
    p_category_ids: [category.id],
  });
  expect(onRadarErr).toBeNull();
  expect(
    ((onRadar ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);

  const requestedAt = new Date().toISOString();
  const { error: stampErr } = await supabaseAdmin
    .from('vendors')
    .update({ deletion_requested_at: requestedAt })
    .eq('id', vendorId);
  expect(stampErr).toBeNull();
  await supabaseAdmin.from('users').update({ deletion_requested_at: requestedAt }).eq('phone', phone);

  const { data: beforeRestore, error: beforeRestoreErr } = await supabaseAdmin.rpc(
    'get_vendor_restore_status',
    { p_phone: phone },
  );
  expect(beforeRestoreErr, beforeRestoreErr?.message).toBeNull();
  expect(beforeRestore.restore_allowed).toBe(false);
  expect(beforeRestore.deny_reason).toBe('deleted');
  expect(beforeRestore.deletion_requested_at).not.toBeNull();

  const { data: hidden, error: hideErr } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: mode,
    p_category_ids: [category.id],
  });
  expect(hideErr).toBeNull();
  expect(
    ((hidden ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(false);

  const { data: newOrderId, error: bookErr } = await supabaseAdmin.rpc('create_customer_request', {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendorId,
    p_message: 'AFCD booking should fail while scheduled for deletion',
    p_user_phone: customerPhone,
    p_device_id_log: DEVICE_ID,
    p_category_id: category.id,
    p_service_mode: mode,
  });
  expect(newOrderId).toBeFalsy();
  expect(bookErr?.message ?? '').toContain('vendor_not_discoverable');

  const { error: clearErr } = await adminClient.rpc('admin_force_clear_deletion', {
    p_vendor_id: vendorId,
    p_notes: `restore-discoverability ${T}`,
  });
  expect(clearErr, clearErr?.message).toBeNull();

  const { data: afterRestore, error: afterRestoreErr } = await supabaseAdmin.rpc(
    'get_vendor_restore_status',
    { p_phone: phone },
  );
  expect(afterRestoreErr, afterRestoreErr?.message).toBeNull();
  expect(afterRestore.restore_allowed).toBe(true);
  expect(afterRestore.deny_reason).toBeNull();
  expect(afterRestore.deletion_requested_at).toBeNull();

  const { data: visible, error: visErr } = await supabase.rpc('get_radar_category_mode_matches', {
    p_mode: mode,
    p_category_ids: [category.id],
  });
  expect(visErr).toBeNull();
  expect(
    ((visible ?? []) as { vendor_id: string }[]).some((r) => r.vendor_id === vendorId),
  ).toBe(true);

  const { data: bookedId, error: bookedErr } = await supabaseAdmin.rpc('create_customer_request', {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendorId,
    p_message: 'AFCD booking after force-clear',
    p_user_phone: customerPhone,
    p_device_id_log: DEVICE_ID,
    p_category_id: category.id,
    p_service_mode: mode,
  });
  expect(bookedErr, bookedErr?.message).toBeNull();
  expect(bookedId).toBeTruthy();
  if (typeof bookedId === 'string') createdRequestIds.push(bookedId);
});

test('AFCD-04 — vendor row shows Clear deletion only when flagged; reason required; confirm clears', async ({
  page,
}) => {
  const flagged = await seedScheduledDeletionVendor('ui');
  const cleanPhone = nextPhone('990');
  const category = await getActiveCategoryByServiceMode('delivery');
  const { data: clean, error: cleanErr } = await supabaseAdmin
    .from('vendors')
    .insert({
      name: 'Owner ui-clean',
      shop_name: `!000-afcd-ui-clean-${T}`,
      phone: cleanPhone,
      category: category.label,
      service_mode: category.service_mode,
      vendor_type: 'shop',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      is_manual_verified: false,
    })
    .select('id, phone, shop_name')
    .single();
  expect(cleanErr, cleanErr?.message).toBeNull();
  await seedVendorCategory(clean!.id, category);
  createdVendorIds.push(clean!.id);
  createdPhones.push(cleanPhone);

  await loginAsAdminViaSession(page, DEVICE_ID);
  await expect(page.getByTestId('admin-panel')).toBeVisible({ timeout: 8000 });

  const modBtn = page.getByRole('button', { name: /Vendor Moderation/i }).first();
  await expect(modBtn).toBeVisible({ timeout: 8000 });
  const searchVisible = await page
    .getByPlaceholder(/search by name, shop, phone/i)
    .isVisible({ timeout: 1000 })
    .catch(() => false);
  if (!searchVisible) {
    await modBtn.click();
  }
  const searchInput = page.getByPlaceholder(/search by name, shop, phone/i).first();
  await expect(searchInput).toBeVisible({ timeout: 8000 });

  await searchInput.fill(clean!.shop_name);
  await page.waitForTimeout(500);
  await expect(page.locator(`#admin-vendor-${clean!.id}`)).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator(`#admin-vendor-${clean!.id}`).getByTestId('admin-force-clear-deletion'),
  ).toHaveCount(0);

  await searchInput.fill(flagged.shopName);
  await page.waitForTimeout(500);
  const flaggedRow = page.locator(`#admin-vendor-${flagged.id}`);
  await expect(flaggedRow).toBeVisible({ timeout: 15000 });
  await flaggedRow.getByTestId('admin-force-clear-deletion').click();

  const confirmBtn = page.getByRole('button', { name: 'Confirm clear' });
  await expect(confirmBtn).toBeDisabled();
  await page.getByTestId('admin-force-clear-deletion-reason').fill(`UI force-clear ${T}`);
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();
  await expect(flaggedRow.getByTestId('admin-force-clear-deletion')).toHaveCount(0, {
    timeout: 15000,
  });

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('deletion_requested_at')
    .eq('id', flagged.id)
    .single();
  expect(row?.deletion_requested_at).toBeNull();
});
