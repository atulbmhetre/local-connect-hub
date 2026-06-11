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

export async function createTestVendor() {
  const { data, error } = await supabase
    .from('vendors')
    .insert({
      name: `Test Vendor ${TEST_SESSION}`,
      shop_name: `Test Shop ${TEST_SESSION}`,
      phone: TEST_VENDOR_PHONE,
      category: 'Grocery',
      service_mode: 'delivery',
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      vendor_note: `test_session:${TEST_SESSION}`
    })
    .select()
    .single();
  if (error) throw error;
  return data;
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
