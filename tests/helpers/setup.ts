import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.test' });

export const supabase = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.VITE_SUPABASE_ANON_KEY!
);

/** Bypass RLS for test seed/cleanup on restricted tables (vendor_categories, vendor_verification). */
export const supabaseAdmin = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.VITE_SUPABASE_ANON_KEY!,
);

export const TEST_SESSION = `test_${Date.now()}`;

export const TEST_VENDOR_PHONE = `99000${Date.now().toString().slice(-5)}`;
export const TEST_CUSTOMER_PHONE = `88000${Date.now().toString().slice(-5)}`;
export const TEST_ADMIN_PHONE = '8888169446';

export type RegisterVendorRpcOptions = {
  name?: string;
  shop_name?: string;
  category?: string;
  phone?: string;
  upi_id?: string;
  service_mode?: string;
  vendor_type?: string;
  vendor_note?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  referral_code?: string;
  profile_status?: 'draft' | 'complete';
  category_ids?: string[];
  category_service_modes?: string[];
  /** Preserved from legacy factory; register_vendor always inserts is_active=false. */
  is_active?: boolean;
};

export async function invokeRegisterVendorRpc(
  opts: RegisterVendorRpcOptions = {},
): Promise<{ vendorId?: string; error?: { code?: string; message: string } }> {
  const categoryRow = await getFirstActiveCategory();
  const categoryIds = opts.category_ids ?? [categoryRow.id];
  const serviceModes = opts.category_service_modes ?? [categoryRow.service_mode];
  const phone = opts.phone ?? TEST_VENDOR_PHONE;

  const { data, error } = await supabase.rpc('register_vendor', {
    p_name: opts.name ?? `Test Vendor ${TEST_SESSION}`,
    p_shop_name: opts.shop_name ?? `Test Shop ${TEST_SESSION}`,
    p_category: opts.category ?? categoryRow.label,
    p_phone: phone,
    p_upi_id: opts.upi_id ?? 'testvendor@upi',
    p_service_mode: opts.service_mode ?? categoryRow.service_mode,
    p_vendor_type: opts.vendor_type ?? 'shop',
    p_vendor_note: opts.vendor_note ?? `test_session:${TEST_SESSION}`,
    p_latitude: opts.latitude ?? 18.5204,
    p_longitude: opts.longitude ?? 73.8567,
    p_referral_code:
      opts.referral_code ??
      `T${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 4)}`.toUpperCase(),
    p_profile_status: opts.profile_status ?? 'complete',
    p_category_ids: categoryIds,
    p_category_service_modes: serviceModes,
  });

  if (error) {
    return { error: { code: error.code, message: error.message } };
  }
  return { vendorId: data as string };
}

export async function createTestVendor(opts: RegisterVendorRpcOptions = {}) {
  const result = await invokeRegisterVendorRpc(opts);
  if (result.error) throw new Error(result.error.message);

  const vendorId = result.vendorId!;
  if (opts.is_active !== false) {
    await supabase
      .from('vendors')
      .update({ is_active: opts.is_active ?? true })
      .eq('id', vendorId);
  }

  const { data, error } = await supabase
    .from('vendors')
    .select('*')
    .eq('id', vendorId)
    .single();
  if (error) throw error;
  return data;
}

export async function deleteVendorRegistrationArtifacts(vendorId: string) {
  await supabaseAdmin.from('vendor_categories').delete().eq('vendor_id', vendorId);
  await supabaseAdmin.from('vendor_verification').delete().eq('vendor_id', vendorId);
  await supabase
    .from('user_notifications')
    .delete()
    .contains('route_params', { vendor_id: vendorId });
  await supabase.from('vendors').delete().eq('id', vendorId);
}

export async function getActiveCategoryByServiceMode(serviceMode: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, emoji, service_mode')
    .eq('is_active', true)
    .eq('service_mode', serviceMode)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No active category found for service_mode: ${serviceMode}`);
  return data;
}

export async function getFirstActiveCategory() {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(1)
    .single();
  if (error) throw error;
  return data;
}

export async function getActiveCategoryByLabel(label: string) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, service_mode')
    .eq('is_active', true)
    .ilike('label', label)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No active category found for label: ${label}`);
  return data;
}

export async function getActiveCategories(limit: number) {
  const { data, error } = await supabase
    .from('categories')
    .select('id, label, emoji, service_mode')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function seedVendorCategory(
  vendorId: string,
  category: { id: string; service_mode: string },
  opts: { is_primary?: boolean; needs_review?: boolean } = {},
) {
  const { error } = await supabaseAdmin.from('vendor_categories').insert({
    vendor_id: vendorId,
    category_id: category.id,
    is_primary: opts.is_primary ?? true,
    status: 'approved',
    needs_review: opts.needs_review ?? false,
    service_mode: category.service_mode,
  });
  if (error) throw error;
}

export async function seedDefaultVendorVerification(vendorId: string) {
  const { error } = await supabaseAdmin.from('vendor_verification').insert([
    { vendor_id: vendorId, check_type: 'upi_format', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'upi_pennydrop', status: 'dormant', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_shop', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_selfie', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'gps', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'admin_check', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'aadhaar_digilocker', status: 'dormant', checked_by: 'system', is_latest: true },
  ]);
  if (error) throw error;
}

export async function seedBronzeVendorVerification(vendorId: string) {
  const { error } = await supabaseAdmin.from('vendor_verification').insert([
    { vendor_id: vendorId, check_type: 'upi_format', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'upi_pennydrop', status: 'dormant', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_shop', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'photo_selfie', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'gps', status: 'passed', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'admin_check', status: 'pending', checked_by: 'system', is_latest: true },
    { vendor_id: vendorId, check_type: 'aadhaar_digilocker', status: 'dormant', checked_by: 'system', is_latest: true },
  ]);
  if (error) throw error;
}

export async function createTestCustomer() {
  const { data, error } = await supabase
    .from('users')
    .insert({
      phone: TEST_CUSTOMER_PHONE,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Delete test vendors (phone 99000* or name Test*) and dependent rows in FK-safe order. */
export async function cleanupTestVendors() {
  const [{ data: byPhone }, { data: byName }] = await Promise.all([
    supabase.from('vendors').select('id').like('phone', '99000%'),
    supabase.from('vendors').select('id').like('name', 'Test%'),
  ]);

  const vendorIds = [
    ...new Set([...(byPhone ?? []), ...(byName ?? [])].map((row) => row.id)),
  ];

  if (vendorIds.length > 0) {
    await supabase
      .from('categories')
      .update({ suggested_by_vendor_id: null })
      .in('suggested_by_vendor_id', vendorIds);
    await supabase
      .from('app_users')
      .update({ referred_by_vendor_id: null })
      .in('referred_by_vendor_id', vendorIds);
    await supabase
      .from('feed_replies')
      .update({ suggested_vendor_id: null })
      .in('suggested_vendor_id', vendorIds);

    await supabase.from('vendor_credits').delete().in('vendor_id', vendorIds);
    await supabase.from('referrals').delete().in('referrer_vendor_id', vendorIds);
    await supabase.from('referrals').delete().like('referee_id', '99000%');

    const { data: requestRows } = await supabase
      .from('requests')
      .select('id')
      .in('vendor_id', vendorIds);
    const requestIds = requestRows?.map((r) => r.id) ?? [];
    if (requestIds.length > 0) {
      await supabase.from('order_items').delete().in('request_id', requestIds);
    }
    await supabase.from('requests').delete().in('vendor_id', vendorIds);

    await supabase.from('saved_vendors').delete().in('vendor_id', vendorIds);
    await supabase.from('vendor_reviews').delete().in('vendor_id', vendorIds);
    await supabase.from('order_bills').delete().in('vendor_id', vendorIds);
    await supabase.from('khata_transactions').delete().in('vendor_id', vendorIds);
    await supabase.from('khata_ledger').delete().in('vendor_id', vendorIds);
    await supabase.from('user_flags').delete().in('vendor_id', vendorIds);
    await supabase.from('vendor_menu_items').delete().in('vendor_id', vendorIds);

    const { data: postRows } = await supabase
      .from('feed_posts')
      .select('id')
      .in('vendor_id', vendorIds);
    const postIds = postRows?.map((p) => p.id) ?? [];
    if (postIds.length > 0) {
      await supabase.from('feed_flags').delete().in('post_id', postIds);
      await supabase.from('feed_replies').delete().in('post_id', postIds);
    }
    await supabase.from('feed_posts').delete().in('vendor_id', vendorIds);

    await supabaseAdmin.from('vendor_categories').delete().in('vendor_id', vendorIds);
    await supabaseAdmin.from('vendor_verification').delete().in('vendor_id', vendorIds);
    await supabase.from('vendors').delete().in('id', vendorIds);
  } else {
    await supabase.from('referrals').delete().like('referee_id', '99000%');
  }
}

export async function cleanupTestData() {
  // Delete in FK-safe order
  await supabase.from('vendor_reviews').delete().like('user_phone', '88000%');
  await supabase.from('order_items').delete().in(
    'request_id',
    (await supabase.from('requests').select('id').like('user_phone', '88000%')).data?.map(r => r.id) ?? []
  );
  await supabase.from('order_bills').delete().in(
    'request_id',
    (await supabase.from('requests').select('id').like('user_phone', '88000%')).data?.map(r => r.id) ?? []
  );
  await supabase.from('khata_transactions').delete().like('user_phone', '88000%');
  await supabase.from('khata_ledger').delete().like('user_phone', '88000%');
  await supabase.from('user_notifications').delete().like('user_phone', '88000%');
  await supabase.from('user_notifications').delete().like('user_phone', '99000%');
  await supabase.from('requests').delete().like('user_phone', '88000%');
  await supabase.from('saved_vendors').delete().like('user_phone', '88000%');
  await supabase.from('admin_actions').delete().like('target_id', '%test%');
  await supabase.from('referrals').delete().like('referee_id', '88000%');
  await supabase.from('users').delete().like('phone', '88000%');
}
