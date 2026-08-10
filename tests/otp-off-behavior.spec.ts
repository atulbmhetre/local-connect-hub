import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import {
  supabaseAdmin,
  invokeRegisterVendorRpc,
  TEST_ADMIN_PHONE,
  deleteVendorRegistrationArtifacts,
} from './helpers/setup';

dotenv.config({ path: '.env.test' });

const SESSION = `otpoff_${Date.now()}`;

function createOtpOffClient() {
  return createClient(
    process.env.VITE_SUPABASE_URL!,
    process.env.VITE_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

test.describe('OTP-off production fidelity (no Supabase session)', () => {
  const customerPhone = `77${String(Date.now()).slice(-8)}`;
  const deviceId = `device_${SESSION}`;
  let vendorId: string | undefined;
  let addressId: string | undefined;

  test.afterAll(async () => {
    if (addressId) {
      await supabaseAdmin.from('user_addresses').delete().eq('id', addressId);
    } else {
      await supabaseAdmin.from('user_addresses').delete().eq('user_phone', customerPhone);
    }
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);
    if (vendorId) {
      await deleteVendorRegistrationArtifacts(vendorId);
    }
  });

  test('customer order path: upsert_app_user persists users row', async () => {
    const anon = createOtpOffClient();
    await supabaseAdmin.from('users').delete().eq('phone', customerPhone);

    const { error } = await anon.rpc('upsert_app_user', {
      p_phone: customerPhone,
      p_lang: 'en',
    });
    expect(error, error?.message).toBeNull();

    const { data } = await supabaseAdmin
      .from('users')
      .select('phone, last_active')
      .eq('phone', customerPhone)
      .single();

    expect(data?.phone).toBe(customerPhone);
    expect(data?.last_active).toBeTruthy();
  });

  test('customer edits saved address via update_user_address RPC', async () => {
    const anon = createOtpOffClient();

    const { error: insertError } = await anon.rpc('insert_user_address', {
      p_device_id: deviceId,
      p_user_phone: customerPhone,
      p_label: 'Home',
      p_address_text: 'Original address',
      p_is_default: true,
    });
    expect(insertError, insertError?.message).toBeNull();

    const { data: rows, error: selectError } = await supabaseAdmin
      .from('user_addresses')
      .select('id')
      .eq('user_phone', customerPhone)
      .limit(1);
    expect(selectError).toBeNull();
    expect(rows?.length).toBe(1);
    addressId = rows![0].id as string;

    const { error: updateError } = await anon.rpc('update_user_address', {
      p_user_phone: customerPhone,
      p_address_id: addressId,
      p_address_text: 'Updated address',
    });
    expect(updateError, updateError?.message).toBeNull();

    const { data } = await supabaseAdmin
      .from('user_addresses')
      .select('address_text')
      .eq('id', addressId)
      .single();

    expect(data?.address_text).toBe('Updated address');
  });

  test('vendor selfie verification via submit_vendor_verification RPC', async () => {
    const vendorPhone = `88${String(Date.now()).slice(-8)}`;
    const anon = createOtpOffClient();

    const { vendorId: vid, error: regError } = await invokeRegisterVendorRpc({
      phone: vendorPhone,
      shop_name: `OTP Off Shop ${SESSION}`,
      name: `OTP Off Vendor ${SESSION}`,
    });
    expect(regError).toBeUndefined();
    expect(vid).toBeTruthy();
    vendorId = vid;

    const { error } = await anon.rpc('submit_vendor_verification', {
      p_vendor_id: vendorId,
      p_vendor_phone: vendorPhone,
      p_check_type: 'photo_selfie',
      p_doc_url: 'https://example.test/selfie.jpg',
    });
    expect(error, error?.message).toBeNull();

    // Without vendors.photo_selfie set, auto-sync leaves check dormant (not pending forever).
    const { data: beforeSelfie, error: beforeErr } = await supabaseAdmin
      .from('vendor_verification')
      .select('check_type, status, is_latest')
      .eq('vendor_id', vendorId)
      .eq('check_type', 'photo_selfie')
      .eq('is_latest', true)
      .maybeSingle();
    expect(beforeErr).toBeNull();
    expect(beforeSelfie?.status).toBe('dormant');

    const { error: patchErr } = await supabaseAdmin
      .from('vendors')
      .update({ photo_selfie: 'https://example.test/selfie.jpg' })
      .eq('id', vendorId);
    expect(patchErr).toBeNull();

    const { data, error: verifyError } = await supabaseAdmin
      .from('vendor_verification')
      .select('check_type, status, is_latest')
      .eq('vendor_id', vendorId)
      .eq('check_type', 'photo_selfie')
      .eq('is_latest', true)
      .maybeSingle();

    expect(verifyError).toBeNull();
    expect(data?.status).toBe('passed');
  });

  test('admin dashboard stats via get_admin_dashboard_stats RPC', async () => {
    const { getAdminSessionClient } = await import('./helpers/browser-setup');
    const adminClient = await getAdminSessionClient();

    const { count: expectedTotal, error: countError } = await supabaseAdmin
      .from('requests')
      .select('id', { count: 'exact', head: true });
    expect(countError).toBeNull();

    const { data, error } = await adminClient.rpc('get_admin_dashboard_stats', {
      p_admin_phone: TEST_ADMIN_PHONE,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toBeTruthy();

    const stats = data as Record<string, number>;
    expect(stats.total_orders).toBe(expectedTotal ?? 0);
    expect(stats.total_vendors).toBeGreaterThan(0);
    expect(typeof stats.total_customers).toBe('number');
  });
});
