import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';
import { supabase, supabaseAdmin, TEST_SESSION } from './helpers/setup';

const EDGE_FUNCTION_NAME = 'process-vendor-referral';
const RATE_LIMIT_IP = 'unknown';

async function invokeProcessVendorReferral(body: Record<string, unknown>) {
  return supabase.functions.invoke(EDGE_FUNCTION_NAME, { body });
}

async function cleanupRateLimitRows() {
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', EDGE_FUNCTION_NAME)
    .eq('identifier', RATE_LIMIT_IP);
}

test('PVR-RL-01: 10 rapid calls are not rate-limited (business errors allowed); 11th is blocked', async () => {
  const invalidCode = `NOPE${TEST_SESSION}`.toUpperCase();

  try {
    for (let i = 0; i < 10; i++) {
      const { data, error } = await invokeProcessVendorReferral({
        new_vendor_id: randomUUID(),
        referral_code: invalidCode,
      });
      expect(error, error?.message).toBeNull();
      const payload = data as { success?: boolean; error?: string };
      expect(payload?.error).not.toContain('Too many requests');
    }

    const eleventh = await invokeProcessVendorReferral({
      new_vendor_id: randomUUID(),
      referral_code: invalidCode,
    });
    expect(eleventh.error, eleventh.error?.message).toBeNull();
    const payload = eleventh.data as { success?: boolean; error?: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('Too many requests');
  } finally {
    await cleanupRateLimitRows();
  }
});
