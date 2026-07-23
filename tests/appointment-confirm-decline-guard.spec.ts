import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  createTestVendor,
  createTestCustomer,
  cleanupTestData,
  cleanupTestVendors,
  TEST_CUSTOMER_PHONE,
  TEST_VENDOR_PHONE,
  getActiveCategoryByServiceMode,
  invokeRegisterVendorRpc,
  ensureVendorGoLivePhotos,
  deleteVendorRegistrationArtifacts,
} from './helpers/setup';

let appointmentVendor: { id: string; phone: string };
let helpVendor: { id: string; phone: string };

test.beforeAll(async () => {
  appointmentVendor = await createTestVendor({ service_mode: 'appointment' });
  const helpCat = await getActiveCategoryByServiceMode('help');
  const phone = `99007${Date.now().toString().slice(-5)}`;
  const reg = await invokeRegisterVendorRpc({
    phone,
    category: helpCat.label,
    category_ids: [helpCat.id],
    category_service_modes: ['help'],
    category_modes: { [helpCat.id]: ['help'] },
    service_mode: 'help',
    availability_modes: ['help'],
  });
  if (reg.error || !reg.vendorId) throw new Error(reg.error?.message ?? 'help vendor reg failed');
  await ensureVendorGoLivePhotos(reg.vendorId);
  await supabaseAdmin
    .from('vendors')
    .update({
      is_active: true,
      discoverable: true,
      profile_status: 'complete',
    })
    .eq('id', reg.vendorId);
  await supabaseAdmin
    .from('vendor_categories')
    .update({ status: 'approved', needs_review: false })
    .eq('vendor_id', reg.vendorId);
  const { data: hv } = await supabaseAdmin
    .from('vendors')
    .select('id, phone')
    .eq('id', reg.vendorId)
    .single();
  helpVendor = hv!;

  await createTestCustomer();
  await supabaseAdmin
    .from('vendors')
    .update({ is_active: true, discoverable: true, profile_status: 'complete' })
    .eq('id', appointmentVendor.id);
});

test.afterAll(async () => {
  if (helpVendor?.id) await deleteVendorRegistrationArtifacts(helpVendor.id);
  await cleanupTestVendors();
  await cleanupTestData();
});

test('AP-GUARD-01: confirm then decline same booking raises already_actioned', async () => {
  const apptTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: row, error: insertError } = await supabaseAdmin
    .from('requests')
    .insert({
      vendor_id: appointmentVendor.id,
      user_phone: TEST_CUSTOMER_PHONE,
      device_id: `ap-guard-${Date.now()}`,
      message: 'AP-GUARD-01 pending booking',
      status: 'sent',
      appointment_time: apptTime,
      appointment_status: 'pending',
      service_mode: 'appointment',
    })
    .select('id')
    .single();
  expect(insertError).toBeNull();
  const requestId = row!.id;

  const vendorPhone = appointmentVendor.phone ?? TEST_VENDOR_PHONE;
  const { error: confirmError } = await supabaseAdmin.rpc('vendor_confirm_appointment', {
    p_request_id: requestId,
    p_vendor_id: appointmentVendor.id,
    p_vendor_phone: vendorPhone,
  });
  expect(confirmError, confirmError?.message).toBeNull();

  const { data: afterConfirm } = await supabaseAdmin
    .from('requests')
    .select('appointment_status, status')
    .eq('id', requestId)
    .single();
  expect(afterConfirm?.appointment_status).toBe('confirmed');
  expect(afterConfirm?.status).toBe('accepted');

  const { error: declineError } = await supabaseAdmin.rpc('vendor_decline_booking', {
    p_request_id: requestId,
    p_vendor_id: appointmentVendor.id,
    p_vendor_phone: vendorPhone,
    p_cancel_reason: 'Too busy',
  });
  expect(declineError?.message ?? '').toMatch(/already_actioned/);

  const { data: afterDecline } = await supabaseAdmin
    .from('requests')
    .select('appointment_status, status')
    .eq('id', requestId)
    .single();
  // Must not overwrite confirmed → declined
  expect(afterDecline?.appointment_status).toBe('confirmed');
  expect(afterDecline?.status).toBe('accepted');

  await supabaseAdmin.from('requests').delete().eq('id', requestId);
});

test('NOTIFY-REQ-01: create_customer_request server-triggers vendor new_order inbox', async () => {
  const deviceId = `notify-req-${Date.now()}`;
  const msg = `NOTIFY-REQ-01 help ${Date.now()}`;

  const { data: requestId, error } = await supabaseAdmin.rpc('create_customer_request', {
    p_device_id: deviceId,
    p_vendor_id: helpVendor.id,
    p_message: msg,
    p_user_phone: TEST_CUSTOMER_PHONE,
    p_device_id_log: deviceId,
    p_service_mode: 'help',
  });
  expect(error, error?.message).toBeNull();
  expect(requestId).toBeTruthy();

  const vendorPhone = helpVendor.phone ?? TEST_VENDOR_PHONE;
  let found = false;
  for (let i = 0; i < 20; i++) {
    const { data: notifs } = await supabaseAdmin
      .from('user_notifications')
      .select('id, type, body, route')
      .eq('user_phone', vendorPhone)
      .eq('type', 'new_order')
      .ilike('body', `%${msg.slice(0, 40)}%`)
      .limit(1);
    if (notifs && notifs.length > 0) {
      found = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(found, 'expected server-side notify-vendor inbox row for new_order').toBe(true);

  await supabaseAdmin.from('requests').delete().eq('id', requestId as string);
  await supabaseAdmin
    .from('user_notifications')
    .delete()
    .eq('user_phone', vendorPhone)
    .eq('type', 'new_order');
});
