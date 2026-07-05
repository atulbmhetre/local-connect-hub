import { test, expect } from '@playwright/test';
import { supabaseAdmin, TEST_SESSION } from './helpers/setup';

const RPC_FUNCTION_NAME = 'rate_limit_rpc_test';

function testId(suffix: string): string {
  return `rl_rpc_${TEST_SESSION}_${suffix}`;
}

async function callRateLimitRpc(opts: {
  identifierType: 'device_id' | 'ip';
  identifier: string;
  maxRequests: number;
  windowSeconds: number;
}) {
  return supabaseAdmin.rpc('check_and_log_rate_limit', {
    p_function_name: RPC_FUNCTION_NAME,
    p_identifier_type: opts.identifierType,
    p_identifier: opts.identifier,
    p_max_requests: opts.maxRequests,
    p_window_seconds: opts.windowSeconds,
  });
}

async function cleanupRateLimitRows(identifiers: string[]) {
  if (identifiers.length === 0) return;
  await supabaseAdmin
    .from('edge_function_rate_limits')
    .delete()
    .eq('function_name', RPC_FUNCTION_NAME)
    .in('identifier', identifiers);
}

test('RL-01: requests under the limit are all allowed', async () => {
  const identifier = testId('01');
  try {
    for (let i = 0; i < 3; i++) {
      const { data, error } = await callRateLimitRpc({
        identifierType: 'device_id',
        identifier,
        maxRequests: 5,
        windowSeconds: 60,
      });
      expect(error, error?.message).toBeNull();
      expect(data).toBe(true);
    }
  } finally {
    await cleanupRateLimitRows([identifier]);
  }
});

test('RL-02: the request that exceeds max_requests within the window is blocked', async () => {
  const identifier = testId('02');
  try {
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const { data, error } = await callRateLimitRpc({
        identifierType: 'device_id',
        identifier,
        maxRequests: 5,
        windowSeconds: 60,
      });
      expect(error, error?.message).toBeNull();
      results.push(data === true);
    }
    expect(results).toEqual([true, true, true, true, true, false]);
  } finally {
    await cleanupRateLimitRows([identifier]);
  }
});

test('RL-03: two different identifiers never interfere with each other counts', async () => {
  const idA = testId('03a');
  const idB = testId('03b');
  try {
    for (let i = 0; i < 5; i++) {
      const a = await callRateLimitRpc({
        identifierType: 'device_id',
        identifier: idA,
        maxRequests: 5,
        windowSeconds: 60,
      });
      expect(a.error, a.error?.message).toBeNull();
      expect(a.data).toBe(true);
    }

    const blockedA = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier: idA,
      maxRequests: 5,
      windowSeconds: 60,
    });
    expect(blockedA.error, blockedA.error?.message).toBeNull();
    expect(blockedA.data).toBe(false);

    const bFirst = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier: idB,
      maxRequests: 5,
      windowSeconds: 60,
    });
    expect(bFirst.error, bFirst.error?.message).toBeNull();
    expect(bFirst.data).toBe(true);
  } finally {
    await cleanupRateLimitRows([idA, idB]);
  }
});

test('RL-04: device_id and ip are tracked as independent buckets even with the same raw string', async () => {
  const shared = testId('04');
  try {
    for (let i = 0; i < 5; i++) {
      const device = await callRateLimitRpc({
        identifierType: 'device_id',
        identifier: shared,
        maxRequests: 5,
        windowSeconds: 60,
      });
      expect(device.error, device.error?.message).toBeNull();
      expect(device.data).toBe(true);
    }

    const deviceBlocked = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier: shared,
      maxRequests: 5,
      windowSeconds: 60,
    });
    expect(deviceBlocked.error, deviceBlocked.error?.message).toBeNull();
    expect(deviceBlocked.data).toBe(false);

    const ipAllowed = await callRateLimitRpc({
      identifierType: 'ip',
      identifier: shared,
      maxRequests: 5,
      windowSeconds: 60,
    });
    expect(ipAllowed.error, ipAllowed.error?.message).toBeNull();
    expect(ipAllowed.data).toBe(true);
  } finally {
    await cleanupRateLimitRows([shared]);
  }
});

test('RL-05: after the window elapses, a previously-blocked identifier is allowed again', async () => {
  const identifier = testId('05');
  try {
    const first = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier,
      maxRequests: 2,
      windowSeconds: 2,
    });
    expect(first.error, first.error?.message).toBeNull();
    expect(first.data).toBe(true);

    const second = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier,
      maxRequests: 2,
      windowSeconds: 2,
    });
    expect(second.error, second.error?.message).toBeNull();
    expect(second.data).toBe(true);

    const blocked = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier,
      maxRequests: 2,
      windowSeconds: 2,
    });
    expect(blocked.error, blocked.error?.message).toBeNull();
    expect(blocked.data).toBe(false);

    await new Promise((r) => setTimeout(r, 2500));

    const allowedAgain = await callRateLimitRpc({
      identifierType: 'device_id',
      identifier,
      maxRequests: 2,
      windowSeconds: 2,
    });
    expect(allowedAgain.error, allowedAgain.error?.message).toBeNull();
    expect(allowedAgain.data).toBe(true);
  } finally {
    await cleanupRateLimitRows([identifier]);
  }
});
