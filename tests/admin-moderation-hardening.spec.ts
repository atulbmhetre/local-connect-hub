import { test, expect } from '@playwright/test';
import { ensureTestAdminUser, getAdminSessionClient } from './helpers/browser-setup';
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  TEST_ADMIN_PHONE,
} from './helpers/setup';

/**
 * Admin Dashboard & Moderation hardening (migration 20260719120001):
 * waive-off apply + guard-trigger parity, delete-review aggregate recalc,
 * app_config server-side whitelist, recommendation lead queue
 * (contacted / dismiss / restore / auto-resolve), log_admin_action
 * never-skip. RPC-level; requirement-driven.
 */

const T = Date.now();
let seq = 0;

const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdPostIds: string[] = [];
const createdRequestIds: string[] = [];

let adminClient: Awaited<ReturnType<typeof getAdminSessionClient>>;

function nextPhone(prefix: '990' | '880'): string {
  seq += 1;
  return `${prefix}91${String(T + seq).slice(-5)}`;
}

async function seedVendor(tag: string): Promise<{ id: string; phone: string; shopName: string }> {
  const phone = nextPhone('990');
  const category = await getActiveCategoryByServiceMode('delivery');
  const shopName = `!AMH-${tag}-${T}`;
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
      vendor_note: `amh:${T}:${tag}`,
    })
    .select('id, phone, shop_name')
    .single();
  if (error) throw error;
  createdVendorIds.push(data!.id);
  createdPhones.push(phone);
  return { id: data!.id, phone: data!.phone, shopName: data!.shop_name };
}

async function seedCustomer(): Promise<string> {
  const phone = nextPhone('880');
  await supabaseAdmin.from('users').upsert({ phone }, { onConflict: 'phone' });
  createdPhones.push(phone);
  return phone;
}

/** Seed a recommendation lead (recommended_vendor_id NULL — name+phone only). */
async function seedLeadPost(opts: {
  posterPhone: string;
  vendorName: string;
  vendorPhone: string;
}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('feed_posts')
    .insert({
      user_phone: opts.posterPhone,
      content: `AMH lead ${T}-${seq}`,
      type: 'recommendation',
      lat: 18.5204,
      lng: 73.8567,
      recommended_vendor_name: opts.vendorName,
      recommended_vendor_phone: opts.vendorPhone,
    })
    .select('id')
    .single();
  if (error) throw error;
  createdPostIds.push(data!.id);
  return data!.id;
}

type AdminRecRow = {
  id: string;
  admin_contacted_at: string | null;
  admin_dismissed_at: string | null;
  vendor_onboarded: boolean;
};

async function fetchAdminRecs(includeDismissed: boolean): Promise<AdminRecRow[]> {
  const { data, error } = await adminClient.rpc('get_recommendations_for_admin', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_include_dismissed: includeDismissed,
  });
  expect(error, error?.message).toBeNull();
  return Array.isArray(data) ? (data as AdminRecRow[]) : [];
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
  adminClient = await getAdminSessionClient();
});

test.afterAll(async () => {
  if (createdPostIds.length) {
    await supabaseAdmin.from('feed_posts').delete().in('id', createdPostIds);
  }
  if (createdRequestIds.length) {
    await supabaseAdmin.from('vendor_reviews').delete().in('request_id', createdRequestIds);
    await supabaseAdmin.from('requests').delete().in('id', createdRequestIds);
  }
  if (createdVendorIds.length) {
    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', createdVendorIds);
    await supabaseAdmin.from('vendors').delete().in('id', createdVendorIds);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from('users').delete().in('phone', createdPhones);
    await supabaseAdmin.from('app_users').delete().in('phone', createdPhones);
  }
});

// ─── Waive-off ───────────────────────────────────────────────────────────────

test('AMH-01 — waive-off: admin apply sets both columns; anon rejected', async () => {
  const vendor = await seedVendor('w1');

  const { error: anonErr } = await supabase.rpc('admin_apply_vendor_waiveoff', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_percent: 50,
    p_months: 3,
  });
  expect(anonErr, 'anon must not be able to apply a waive-off').not.toBeNull();
  expect(anonErr!.message).toMatch(/unauthorized|permission denied/i);

  const { error } = await adminClient.rpc('admin_apply_vendor_waiveoff', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_percent: 50,
    p_months: 3,
  });
  expect(error, error?.message).toBeNull();

  const { data: row } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(row?.waiveoff_percent).toBe(50);
  expect(row?.waiveoff_months_remaining).toBe(3);
});

test('AMH-02 — waive-off: direct client write to waiveoff columns has no effect', async () => {
  const vendor = await seedVendor('w2');

  // Anon direct write: blocked by RLS (0 rows) or by the guard trigger — either
  // way the stored value must not change.
  const { error: directErr } = await supabase
    .from('vendors')
    .update({ waiveoff_percent: 99, waiveoff_months_remaining: 12 })
    .eq('id', vendor.id);
  if (directErr) {
    expect(directErr.message).toMatch(/direct admin column write blocked|violates row-level security/i);
  }

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('waiveoff_percent, waiveoff_months_remaining')
    .eq('id', vendor.id)
    .single();
  expect(after?.waiveoff_percent).toBeNull();
  expect(after?.waiveoff_months_remaining).toBeNull();
});

test('AMH-03 — waive-off: invalid percent/months rejected server-side', async () => {
  const vendor = await seedVendor('w3');
  const { error: pctErr } = await adminClient.rpc('admin_apply_vendor_waiveoff', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_percent: 101,
    p_months: 3,
  });
  expect(pctErr?.message ?? '').toContain('invalid_percent');

  const { error: mErr } = await adminClient.rpc('admin_apply_vendor_waiveoff', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_vendor_id: vendor.id,
    p_percent: 50,
    p_months: 0,
  });
  expect(mErr?.message ?? '').toContain('invalid_months');
});

// ─── Delete review ───────────────────────────────────────────────────────────

test('AMH-04 — delete review: aggregates recalculated; last delete resets; anon rejected', async () => {
  const vendor = await seedVendor('r1');
  const customer = await seedCustomer();

  const reviewIds: string[] = [];
  for (const rating of [5, 1]) {
    const { data: order, error: orderErr } = await supabaseAdmin
      .from('requests')
      .insert({
        vendor_id: vendor.id,
        user_phone: customer,
        device_id: `device_amh_${T}`,
        message: `AMH review order ${rating}`,
        status: 'fulfilled',
      })
      .select('id')
      .single();
    if (orderErr) throw orderErr;
    createdRequestIds.push(order!.id);

    const { data: review, error: reviewErr } = await supabaseAdmin
      .from('vendor_reviews')
      .insert({
        vendor_id: vendor.id,
        request_id: order!.id,
        user_phone: customer,
        rating,
        service_mode: 'delivery',
      })
      .select('id')
      .single();
    if (reviewErr) throw reviewErr;
    reviewIds.push(review!.id);
  }

  const { error: anonErr } = await supabase.rpc('admin_delete_review', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_review_id: reviewIds[1],
  });
  expect(anonErr, 'anon must not be able to delete reviews').not.toBeNull();

  // Delete the 1-star review — aggregate becomes avg 5.0 / count 1.
  const { error: del1Err } = await adminClient.rpc('admin_delete_review', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_review_id: reviewIds[1],
  });
  expect(del1Err, del1Err?.message).toBeNull();

  const { data: mid } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, review_count')
    .eq('id', vendor.id)
    .single();
  expect(Number(mid?.avg_rating)).toBe(5);
  expect(mid?.review_count).toBe(1);

  // Delete the last review — aggregates reset.
  const { error: del2Err } = await adminClient.rpc('admin_delete_review', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_review_id: reviewIds[0],
  });
  expect(del2Err, del2Err?.message).toBeNull();

  const { data: after } = await supabaseAdmin
    .from('vendors')
    .select('avg_rating, review_count')
    .eq('id', vendor.id)
    .single();
  expect(after?.avg_rating).toBeNull();
  expect(after?.review_count).toBe(0);
});

// ─── app_config whitelist ────────────────────────────────────────────────────

test('AMH-05 — app_config: non-whitelisted key rejected server-side, whitelisted key accepted', async () => {
  const evilKey = `amh_evil_key_${T}`;
  const { error: evilErr } = await adminClient.rpc('admin_update_app_config', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_key: evilKey,
    p_value: 'pwned',
  });
  expect(evilErr, 'non-whitelisted key must be rejected').not.toBeNull();
  expect(evilErr!.message).toContain('key_not_allowed');

  const { data: evilRow } = await supabaseAdmin
    .from('app_config')
    .select('key')
    .eq('key', evilKey)
    .maybeSingle();
  expect(evilRow).toBeNull();

  // Whitelisted key still writable: write the current value back (no-op change).
  const { data: current } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'help_accept_timeout_hours')
    .maybeSingle();
  const currentValue = current?.value ?? '48';
  const { error: okErr } = await adminClient.rpc('admin_update_app_config', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_key: 'help_accept_timeout_hours',
    p_value: currentValue,
  });
  expect(okErr, okErr?.message).toBeNull();

  const { error: anonErr } = await supabase.rpc('admin_update_app_config', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_key: 'help_accept_timeout_hours',
    p_value: currentValue,
  });
  expect(anonErr, 'anon must not be able to update app_config').not.toBeNull();
});

// ─── Recommendation lead queue ───────────────────────────────────────────────

test('AMH-06 — mark contacted: toggles on/off, stays visible in default view, audited, anon rejected', async () => {
  const poster = await seedCustomer();
  const postId = await seedLeadPost({
    posterPhone: poster,
    vendorName: `AMH Lead ${T}`,
    vendorPhone: nextPhone('990'), // not onboarded
  });

  const { error: anonErr } = await supabase.rpc('admin_mark_recommendation_contacted', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
    p_contacted: true,
  });
  expect(anonErr, 'anon must not be able to mark contacted').not.toBeNull();

  const { error: onErr } = await adminClient.rpc('admin_mark_recommendation_contacted', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
    p_contacted: true,
  });
  expect(onErr, onErr?.message).toBeNull();

  const { data: rowOn } = await supabaseAdmin
    .from('feed_posts')
    .select('admin_contacted_at, admin_dismissed_at')
    .eq('id', postId)
    .single();
  expect(rowOn?.admin_contacted_at).not.toBeNull();
  expect(rowOn?.admin_dismissed_at).toBeNull();

  // Contacted is a marker only — the row stays in the default view.
  const defaultView = await fetchAdminRecs(false);
  const inDefault = defaultView.find((r) => r.id === postId);
  expect(inDefault, 'contacted lead must remain in default view').toBeTruthy();
  expect(inDefault!.admin_contacted_at).not.toBeNull();

  const { error: offErr } = await adminClient.rpc('admin_mark_recommendation_contacted', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
    p_contacted: false,
  });
  expect(offErr, offErr?.message).toBeNull();

  const { data: rowOff } = await supabaseAdmin
    .from('feed_posts')
    .select('admin_contacted_at')
    .eq('id', postId)
    .single();
  expect(rowOff?.admin_contacted_at).toBeNull();

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('action_type, target_type')
    .eq('target_id', postId)
    .eq('action_type', 'mark_recommendation_contacted')
    .limit(1);
  expect(audit?.length, 'mark_recommendation_contacted must be audited').toBeGreaterThan(0);
  expect(audit![0].target_type).toBe('feed_post');
});

test('AMH-07 — dismiss/restore: dismiss hides from default view, restore brings it back, audited, anon rejected', async () => {
  const poster = await seedCustomer();
  const postId = await seedLeadPost({
    posterPhone: poster,
    vendorName: `AMH Dismiss ${T}`,
    vendorPhone: nextPhone('990'),
  });

  const { error: anonDismissErr } = await supabase.rpc('admin_dismiss_recommendation', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
  });
  expect(anonDismissErr, 'anon must not be able to dismiss').not.toBeNull();
  const { error: anonRestoreErr } = await supabase.rpc('admin_restore_recommendation', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
  });
  expect(anonRestoreErr, 'anon must not be able to restore').not.toBeNull();

  const { error: dismissErr } = await adminClient.rpc('admin_dismiss_recommendation', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
  });
  expect(dismissErr, dismissErr?.message).toBeNull();

  const defaultView = await fetchAdminRecs(false);
  expect(
    defaultView.find((r) => r.id === postId),
    'dismissed lead must not appear in default view',
  ).toBeUndefined();

  const removedView = await fetchAdminRecs(true);
  const removedRow = removedView.find((r) => r.id === postId);
  expect(removedRow, 'dismissed lead must appear when include_dismissed=true').toBeTruthy();
  expect(removedRow!.admin_dismissed_at).not.toBeNull();
  expect(removedRow!.vendor_onboarded).toBe(false);

  const { error: restoreErr } = await adminClient.rpc('admin_restore_recommendation', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_post_id: postId,
  });
  expect(restoreErr, restoreErr?.message).toBeNull();

  const restoredView = await fetchAdminRecs(false);
  expect(
    restoredView.find((r) => r.id === postId),
    'restored lead must reappear in default view',
  ).toBeTruthy();

  for (const actionType of ['dismiss_recommendation', 'restore_recommendation']) {
    const { data: audit } = await supabaseAdmin
      .from('admin_actions')
      .select('action_type')
      .eq('target_id', postId)
      .eq('action_type', actionType)
      .limit(1);
    expect(audit?.length, `${actionType} must be audited`).toBeGreaterThan(0);
  }
});

test('AMH-08 — auto-resolve: onboarded lead excluded from default view, labelled in include_dismissed view', async () => {
  const poster = await seedCustomer();
  const onboardedVendor = await seedVendor('onb');
  const postId = await seedLeadPost({
    posterPhone: poster,
    vendorName: `AMH Onboarded ${T}`,
    vendorPhone: onboardedVendor.phone, // this phone now exists in vendors
  });

  const defaultView = await fetchAdminRecs(false);
  expect(
    defaultView.find((r) => r.id === postId),
    'auto-resolved lead must be excluded from default view without a dismiss',
  ).toBeUndefined();

  const fullView = await fetchAdminRecs(true);
  const resolvedRow = fullView.find((r) => r.id === postId);
  expect(resolvedRow, 'auto-resolved lead must appear when include_dismissed=true').toBeTruthy();
  expect(resolvedRow!.vendor_onboarded).toBe(true);
  expect(resolvedRow!.admin_dismissed_at).toBeNull();
});

// ─── log_admin_action never skips ────────────────────────────────────────────

test('AMH-09 — log_admin_action: audit row written even with null client label', async () => {
  const targetId = `amh-audit-${T}`;
  const { error } = await adminClient.rpc('log_admin_action', {
    p_admin_phone: null,
    p_action_type: 'update_config',
    p_target_type: 'config',
    p_target_id: targetId,
    p_notes: 'AMH label fallback check',
  });
  expect(error, error?.message).toBeNull();

  const { data: audit } = await supabaseAdmin
    .from('admin_actions')
    .select('admin_phone')
    .eq('target_id', targetId)
    .eq('action_type', 'update_config')
    .limit(1);
  expect(audit?.length).toBeGreaterThan(0);
  expect((audit![0].admin_phone ?? '').length, 'label must be resolved server-side').toBeGreaterThan(0);

  await supabaseAdmin.from('admin_actions').delete().eq('target_id', targetId);
});

// ─── Operational whitelist keys + FCM PUBLIC revoke ──────────────────────────

const OPS_CONFIG_KEYS = [
  'payments_enabled',
  'razorpay_key_id',
  'razorpay_kyc_date',
  'exotel_kyc_date',
  'exotel_credits_low_threshold_inr',
  'vendor_grace_period_days',
  'khata_amber_limit',
] as const;

test('AMH-10 — app_config: 7 operational keys writable; non-whitelist still key_not_allowed', async () => {
  for (const key of OPS_CONFIG_KEYS) {
    const { data: current } = await supabaseAdmin
      .from('app_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    const currentValue = current?.value ?? (key === 'payments_enabled' ? 'false' : '0');
    const { error } = await adminClient.rpc('admin_update_app_config', {
      p_admin_phone: TEST_ADMIN_PHONE,
      p_key: key,
      p_value: currentValue,
    });
    expect(error, `${key}: ${error?.message}`).toBeNull();
  }

  const evilKey = `amh_ops_evil_${T}`;
  const { error: evilErr } = await adminClient.rpc('admin_update_app_config', {
    p_admin_phone: TEST_ADMIN_PHONE,
    p_key: evilKey,
    p_value: 'nope',
  });
  expect(evilErr, 'non-whitelisted key must still be rejected').not.toBeNull();
  expect(evilErr!.message).toContain('key_not_allowed');
});

test('AMH-11 — get_admin_fcm_failure_stats: anon EXECUTE rejected after PUBLIC revoke', async () => {
  const { error: anonErr } = await supabase.rpc('get_admin_fcm_failure_stats', {
    p_hours: 24,
  });
  expect(anonErr, 'anon must not execute get_admin_fcm_failure_stats').not.toBeNull();

  const { error: adminErr } = await adminClient.rpc('get_admin_fcm_failure_stats', {
    p_hours: 24,
  });
  expect(adminErr, adminErr?.message).toBeNull();
});

// ─── Flagged Users list RPC (users_owner RLS bypass for admin) ───────────────

test('AMH-12 — admin_list_flagged_users: admin lists flagged set; non-admin and anon rejected', async () => {
  // Seed a flagged user (noshow) the admin panel should surface.
  const flaggedPhone = await seedCustomer();
  await supabaseAdmin
    .from('users')
    .update({ noshow_count: 2, fake_count: 0, is_banned: false })
    .eq('phone', flaggedPhone);

  // Admin session: flagged user present with the panel's columns.
  const { data: adminRows, error: adminErr } = await adminClient.rpc('admin_list_flagged_users', {
    p_admin_phone: TEST_ADMIN_PHONE,
  });
  expect(adminErr, adminErr?.message).toBeNull();
  const row = (adminRows as Array<Record<string, unknown>> | null)?.find(
    (r) => r.phone === flaggedPhone,
  );
  expect(row, 'seeded flagged user must appear for admin session').toBeTruthy();
  expect(row!.noshow_count).toBe(2);
  expect(row!.is_banned).toBe(false);
  expect(row).toHaveProperty('trust_score');
  expect(row).toHaveProperty('warn_count');
  expect(row).toHaveProperty('last_warned_at');

  // Anon: EXECUTE revoked — must error (permission denied / not found), never data.
  const { data: anonData, error: anonErr } = await supabase.rpc('admin_list_flagged_users', {
    p_admin_phone: TEST_ADMIN_PHONE,
  });
  expect(anonErr, 'anon must not execute admin_list_flagged_users').not.toBeNull();
  expect(anonData ?? null).toBeNull();

  // Plain authenticated (non-admin) session: is_admin_session() gate → unauthorized.
  const email = `amh12.nonadmin.${T}@aaspaas.invalid`;
  const password = `amh12_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const nonAdmin = createClient(
      process.env.VITE_SUPABASE_URL!,
      process.env.VITE_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error: signInErr } = await nonAdmin.auth.signInWithPassword({ email, password });
    expect(signInErr, signInErr?.message).toBeNull();

    const { data: nonAdminData, error: nonAdminErr } = await nonAdmin.rpc(
      'admin_list_flagged_users',
      { p_admin_phone: TEST_ADMIN_PHONE },
    );
    expect(nonAdminErr, 'non-admin authenticated session must be rejected').not.toBeNull();
    expect(nonAdminErr!.message).toContain('unauthorized');
    expect(nonAdminData ?? null).toBeNull();
  } finally {
    if (created?.user?.id) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    }
  }
});
