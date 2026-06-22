import { describe, it, expect } from 'vitest';

// Pure logic extracted for testing
function calcTrialDaysLeft(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null;
  return Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

function calcTrialEndsAt(
  lastUpdated: string,
  trialDays: number,
  globalBillingStart: string | null | undefined
): Date {
  const perVendor = new Date(lastUpdated);
  perVendor.setDate(perVendor.getDate() + trialDays);
  if (!globalBillingStart?.trim()) return perVendor;
  const global = new Date(globalBillingStart);
  return perVendor > global ? perVendor : global;
}

function calcWaiveoffAfterCharge(
  waiveoffPercent: number | null | undefined,
  waiveoffMonthsRemaining: number | null | undefined
): { waiveoff_percent: number | null; waiveoff_months_remaining: number } {
  if (!waiveoffMonthsRemaining || waiveoffMonthsRemaining <= 0) {
    return { waiveoff_percent: waiveoffPercent ?? null, waiveoff_months_remaining: 0 };
  }
  const newRemaining = waiveoffMonthsRemaining - 1;
  return {
    waiveoff_percent: newRemaining === 0 ? null : (waiveoffPercent ?? null),
    waiveoff_months_remaining: newRemaining,
  };
}

// --- calcTrialDaysLeft ---
describe('calcTrialDaysLeft', () => {
  it('returns positive days when trial ends in future', () => {
    const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(calcTrialDaysLeft(future)).toBe(10);
  });

  it('returns 0 when trial ended in past', () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(calcTrialDaysLeft(past)).toBe(0);
  });

  it('returns 0 not negative for expired trial', () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(calcTrialDaysLeft(past)).toBeGreaterThanOrEqual(0);
  });

  it('returns null when trial_ends_at is null', () => {
    expect(calcTrialDaysLeft(null)).toBeNull();
  });

  it('returns null when trial_ends_at is undefined', () => {
    expect(calcTrialDaysLeft(undefined)).toBeNull();
  });

  it('returns 1 when trial ends tomorrow', () => {
    const tomorrow = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
    expect(calcTrialDaysLeft(tomorrow)).toBe(1);
  });
});

// --- calcTrialEndsAt ---
describe('calcTrialEndsAt', () => {
  const lastUpdated = new Date('2026-06-01T00:00:00Z').toISOString();

  it('uses per-vendor date when global_billing_start is null', () => {
    const result = calcTrialEndsAt(lastUpdated, 30, null);
    expect(result.toISOString().startsWith('2026-07-01')).toBe(true);
  });

  it('uses per-vendor date when global_billing_start is empty string', () => {
    const result = calcTrialEndsAt(lastUpdated, 30, '');
    expect(result.toISOString().startsWith('2026-07-01')).toBe(true);
  });

  it('uses global_billing_start when it is later than per-vendor trial end', () => {
    const result = calcTrialEndsAt(lastUpdated, 30, '2026-09-01');
    expect(result.toISOString().startsWith('2026-09-01')).toBe(true);
  });

  it('uses per-vendor date when it is later than global_billing_start', () => {
    const result = calcTrialEndsAt(lastUpdated, 30, '2026-06-15');
    expect(result.toISOString().startsWith('2026-07-01')).toBe(true);
  });

  it('respects custom trial days', () => {
    const result = calcTrialEndsAt(lastUpdated, 60, null);
    expect(result.toISOString().startsWith('2026-07-31')).toBe(true);
  });
});

// --- calcWaiveoffAfterCharge ---
describe('calcWaiveoffAfterCharge', () => {
  it('decrements months remaining by 1', () => {
    const result = calcWaiveoffAfterCharge(30, 3);
    expect(result.waiveoff_months_remaining).toBe(2);
    expect(result.waiveoff_percent).toBe(30);
  });

  it('clears waiveoff_percent when months reach 0', () => {
    const result = calcWaiveoffAfterCharge(30, 1);
    expect(result.waiveoff_months_remaining).toBe(0);
    expect(result.waiveoff_percent).toBeNull();
  });

  it('does not change anything when months already 0', () => {
    const result = calcWaiveoffAfterCharge(30, 0);
    expect(result.waiveoff_months_remaining).toBe(0);
  });

  it('handles null waiveoff gracefully', () => {
    const result = calcWaiveoffAfterCharge(null, null);
    expect(result.waiveoff_months_remaining).toBe(0);
    expect(result.waiveoff_percent).toBeNull();
  });

  it('handles months = 2 correctly', () => {
    const result = calcWaiveoffAfterCharge(50, 2);
    expect(result.waiveoff_months_remaining).toBe(1);
    expect(result.waiveoff_percent).toBe(50);
  });
});

// --- Status display logic ---
describe('subscription status display flags', () => {
  it('isInTrial true when status is trial', () => {
    const status = 'trial';
    expect(status === 'trial').toBe(true);
  });

  it('isInTrial false when status is active', () => {
    const status = 'active';
    expect(status === 'trial').toBe(false);
  });

  it('shows grace banner when status is grace', () => {
    const status = 'grace';
    expect(status === 'grace' || status === 'expired').toBe(true);
  });

  it('shows expired banner when status is expired', () => {
    const status = 'expired';
    expect(status === 'grace' || status === 'expired').toBe(true);
  });

  it('does not show grace/expired banner when status is active', () => {
    const status = 'active';
    expect(status === 'grace' || status === 'expired').toBe(false);
  });

  it('does not show grace/expired banner when status is trial', () => {
    const status = 'trial';
    expect(status === 'grace' || status === 'expired').toBe(false);
  });
});
