import { test, expect } from '@playwright/test';
import { loginAsCustomer, APP_URL } from './helpers/browser-setup';
import {
  supabaseAdmin,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
  cleanupTestVendors,
  TEST_SESSION,
} from './helpers/setup';

const PHASE_D_TEST_DEBT =
  'Phase D test debt — full radar→parchi order flow needs session-aware redesign. Tracked for dedicated test session.';

const T = Date.now();
const CUSTOMER_PHONE = `88008${String(T).slice(-5)}`;
const DEVICE_ID = `device_mcv_e2e_${T}`;

test.afterAll(async () => {
  await cleanupTestVendors();
  await supabaseAdmin.from('requests').delete().eq('user_phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('users').delete().eq('phone', CUSTOMER_PHONE);
  await supabaseAdmin.from('app_users').delete().eq('phone', CUSTOMER_PHONE);
});

test('MCV-E2E-01: customer finds multi-category vendor via secondary category and places order', async ({
  page,
}) => {
  // Same skip as DM-01-BROWSER — OTP/session + radar→parchi E2E is tracked Phase D debt.
  test.skip(true, PHASE_D_TEST_DEBT);

  const electrician = await getActiveCategoryByLabel('Electrician');
  const plumber = await getActiveCategoryByLabel('Plumber');
  const vendorPhone = `99008${String(T).slice(-5)}`;
  const shopName = `!MCV-E2E-${T}`;
  const orderMessage = `MCV E2E order ${T}`;

  const registerResult = await invokeRegisterVendorRpc({
    phone: vendorPhone,
    shop_name: shopName,
    category: electrician.label,
    service_mode: electrician.service_mode,
    category_ids: [electrician.id, plumber.id],
    category_service_modes: [electrician.service_mode, plumber.service_mode],
    vendor_note: `test_session:${TEST_SESSION}`,
    latitude: 18.5204,
    longitude: 73.8567,
    profile_status: 'complete',
  });
  expect(registerResult.error).toBeUndefined();
  const vendorId = registerResult.vendorId!;

  try {
    await supabaseAdmin
      .from('vendors')
      .update({
        is_active: true,
        profile_status: 'complete',
        service_radius_km: 9999,
      })
      .eq('id', vendorId);

    await supabaseAdmin.from('users').upsert({ phone: CUSTOMER_PHONE }, { onConflict: 'phone' });
    await supabaseAdmin.from('app_users').upsert({ phone: CUSTOMER_PHONE }, { onConflict: 'phone' });

    await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
    await page.context().setGeolocation({ latitude: 18.5204, longitude: 73.8567 });
    await page.context().grantPermissions(['geolocation']);

    // Search secondary (non-primary) category — Plumber, not Electrician.
    await page.goto(`${APP_URL}/radar?mode=help&q=${encodeURIComponent(plumber.label)}`);

    const vendorCard = page.getByTestId('radar-vendor-card').filter({ hasText: shopName }).first();
    await expect(vendorCard).toBeVisible({ timeout: 20000 });
    await vendorCard.getByTestId('radar-vendor-card-order-btn').click();
    await expect(page.getByTestId('parchi-sheet')).toBeVisible({ timeout: 20000 });

    await page.getByTestId('parchi-message-input').fill(orderMessage);
    await page.getByTestId('parchi-submit-btn').click();

    await expect
      .poll(
        async () => {
          const { data } = await supabaseAdmin
            .from('requests')
            .select('id, vendor_id, message')
            .eq('user_phone', CUSTOMER_PHONE)
            .eq('vendor_id', vendorId)
            .eq('message', orderMessage)
            .maybeSingle();
          return data;
        },
        { timeout: 20000 },
      )
      .toMatchObject({ vendor_id: vendorId, message: orderMessage });
  } finally {
    await deleteVendorRegistrationArtifacts(vendorId);
  }
});
