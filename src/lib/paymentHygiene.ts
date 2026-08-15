/** Tier-1 unpaid bill visual weight threshold (matches cron tier-1). */
export const PAYMENT_HYGIENE_TIER1_MS = 30 * 60 * 1000;

export function isBillPastPaymentHygieneTier1(
  createdAt: string | null | undefined,
  paymentStatus: string,
): boolean {
  if (paymentStatus !== "unpaid" || !createdAt) return false;
  const createdMs = new Date(createdAt).getTime();
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs >= PAYMENT_HYGIENE_TIER1_MS;
}
