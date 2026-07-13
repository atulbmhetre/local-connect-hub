import { test, expect } from '@playwright/test';
import {
  supabaseAdmin,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  TEST_SESSION,
} from './helpers/setup';
import { uniqueTestPhone } from './helpers/session38';

const FUNCTION_NAME = 'register_vendor';

function uniqueReferralCode(suffix: string): string {
  return `RL${suffix}${Date.now().toString(36).slice(-4)}`.toUpperCase();
}

async function cleanupRateLimitRows(phone: string) {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', FUNCTION_NAME)
    .eq('identifier_type', 'phone')
    .eq('identifier', phone);
}

test('RV-RL-01: 3 registrations with the same phone succeed; 4th within 5 minutes is rate-limited', async () => {
  const phone = uniqueTestPhone('99071');
  const createdVendorIds: string[] = [];

  try {
    for (let i = 0; i < 3; i++) {
      const result = await invokeRegisterVendorRpc({
        phone,
        referral_code: uniqueReferralCode(String(i)),
        name: `RV-RL Owner ${TEST_SESSION} ${i}`,
        shop_name: `RV-RL Shop ${TEST_SESSION} ${i}`,
        is_active: false,
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.vendorId).toBeTruthy();
      createdVendorIds.push(result.vendorId!);
      await deleteVendorRegistrationArtifacts(result.vendorId!);
    }

    const fourth = await invokeRegisterVendorRpc({
      phone,
      referral_code: uniqueReferralCode('4'),
      name: `RV-RL Owner ${TEST_SESSION} blocked`,
      shop_name: `RV-RL Shop ${TEST_SESSION} blocked`,
      is_active: false,
    });
    expect(fourth.error).toBeDefined();
    expect(fourth.error!.message).toContain('rate_limited');
    expect(fourth.vendorId).toBeUndefined();
  } finally {
    for (const vendorId of createdVendorIds) {
      await deleteVendorRegistrationArtifacts(vendorId);
    }
    await cleanupRateLimitRows(phone);
  }
});

test('RV-RL-02: a different phone is unaffected when another phone is rate-limited', async () => {
  const limitedPhone = uniqueTestPhone('99072');
  const otherPhone = uniqueTestPhone('99073');
  const createdVendorIds: string[] = [];

  try {
    for (let i = 0; i < 3; i++) {
      const result = await invokeRegisterVendorRpc({
        phone: limitedPhone,
        referral_code: uniqueReferralCode(`L${i}`),
        is_active: false,
      });
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.vendorId).toBeTruthy();
      createdVendorIds.push(result.vendorId!);
      await deleteVendorRegistrationArtifacts(result.vendorId!);
    }

    const blocked = await invokeRegisterVendorRpc({
      phone: limitedPhone,
      referral_code: uniqueReferralCode('LB'),
      is_active: false,
    });
    expect(blocked.error?.message).toContain('rate_limited');

    const other = await invokeRegisterVendorRpc({
      phone: otherPhone,
      referral_code: uniqueReferralCode('O'),
      is_active: false,
    });
    expect(other.error, other.error?.message).toBeUndefined();
    expect(other.vendorId).toBeTruthy();
    createdVendorIds.push(other.vendorId!);
  } finally {
    for (const vendorId of createdVendorIds) {
      await deleteVendorRegistrationArtifacts(vendorId);
    }
    await cleanupRateLimitRows(limitedPhone);
    await cleanupRateLimitRows(otherPhone);
  }
});
