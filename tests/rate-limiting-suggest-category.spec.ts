import { test, expect } from '@playwright/test';
import { supabase, supabaseAdmin, TEST_SESSION } from './helpers/setup';

const EDGE_FUNCTION_NAME = 'suggest-category';

function testDeviceId(suffix: string): string {
  return `rl_sc_${TEST_SESSION}_${suffix}`;
}

async function invokeSuggestCategory(body: Record<string, unknown>) {
  return supabase.functions.invoke(EDGE_FUNCTION_NAME, { body });
}

async function cleanupSuggestCategoryRateLimits(identifiers: string[]) {
  if (identifiers.length === 0) return;
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', EDGE_FUNCTION_NAME)
    .in('identifier', identifiers);
}

async function readFunctionInvokeError(
  error: { message: string; context?: Response } | null,
): Promise<string> {
  if (error?.context) {
    try {
      const body = (await error.context.clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* ignore parse failures */
    }
  }
  return error?.message ?? '';
}

test('SC-RL-01: a normal call with a real description succeeds', async () => {
  const deviceId = testDeviceId('01');
  try {
    const { data, error } = await invokeSuggestCategory({
      description: 'Neighbourhood grocery store selling fresh vegetables and dairy',
      device_id: deviceId,
    });

    expect(error, error?.message).toBeNull();
    expect((data as { success?: boolean })?.success).toBe(true);
  } finally {
    await cleanupSuggestCategoryRateLimits([deviceId, 'unknown']);
  }
});

test('SC-RL-02: 6 rapid calls with the same device_id — first 5 succeed, 6th rate-limited', async () => {
  const deviceId = testDeviceId('02');
  const description = 'Small electronics repair shop for phones and laptops';
  try {
    for (let i = 0; i < 5; i++) {
      const { data, error } = await invokeSuggestCategory({
        description: `${description} ${i}`,
        device_id: deviceId,
      });
      expect(error, error?.message).toBeNull();
      expect((data as { success?: boolean })?.success).toBe(true);
    }

    const sixth = await invokeSuggestCategory({
      description: `${description} 5`,
      device_id: deviceId,
    });
    expect(sixth.error, sixth.error?.message).not.toBeNull();
    const message = await readFunctionInvokeError(sixth.error);
    expect(message).toContain('Too many requests');
  } finally {
    await cleanupSuggestCategoryRateLimits([deviceId, 'unknown']);
  }
});

test('SC-RL-03: 10 rapid health-check calls all return ok and are never blocked', async () => {
  try {
    for (let i = 0; i < 10; i++) {
      const { data, error } = await invokeSuggestCategory({ healthCheck: true });
      expect(error, error?.message).toBeNull();
      expect(data).toEqual({ status: 'ok' });
    }
  } finally {
    await cleanupSuggestCategoryRateLimits(['unknown']);
  }
});

test('SC-RL-04: omitting device_id entirely still succeeds (IP-only limiting)', async () => {
  try {
    const { data, error } = await invokeSuggestCategory({
      description: 'Home bakery selling cakes and bread for local delivery',
    });

    expect(error, error?.message).toBeNull();
    expect((data as { success?: boolean })?.success).toBe(true);
  } finally {
    await cleanupSuggestCategoryRateLimits(['unknown']);
  }
});
