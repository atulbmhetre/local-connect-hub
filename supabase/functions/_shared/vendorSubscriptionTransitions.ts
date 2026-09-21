/** UTC day length. Do not use calendar `setDate` (DST / IST date boundaries). */
export const MS_PER_DAY = 86_400_000;

export function addUtcDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MS_PER_DAY);
}

/**
 * Matches SQL `vendor_effective_trial_end`:
 * created_at + vendor_trial_days + pause_credit_days.
 * Does not read `trial_ends_at`.
 */
export function vendorEffectiveTrialEnd(params: {
  createdAt: Date | string;
  vendorTrialDays: number;
  pauseCreditDays: number;
}): Date {
  const created = params.createdAt instanceof Date
    ? params.createdAt
    : new Date(params.createdAt);
  const days = params.vendorTrialDays + params.pauseCreditDays;
  return addUtcDays(created, days);
}

export function shouldSkipTrialToGrace(params: {
  now: Date;
  createdAt: Date | string;
  vendorTrialDays: number;
  pauseCreditDays: number;
  globalBillingStart: Date | null;
  hasOpenBillingWindow: boolean;
}): boolean {
  if (params.hasOpenBillingWindow) return true;
  if (params.globalBillingStart && params.now < params.globalBillingStart) return true;
  const trialEnd = vendorEffectiveTrialEnd({
    createdAt: params.createdAt,
    vendorTrialDays: params.vendorTrialDays,
    pauseCreditDays: params.pauseCreditDays,
  });
  return params.now < trialEnd;
}

export function shouldSkipGraceToExpired(params: {
  now: Date;
  graceEndsAt: Date | string;
  hasOpenBillingWindow: boolean;
}): boolean {
  if (params.hasOpenBillingWindow) return true;
  const graceEnd = params.graceEndsAt instanceof Date
    ? params.graceEndsAt
    : new Date(params.graceEndsAt);
  return params.now < graceEnd;
}
