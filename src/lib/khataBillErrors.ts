/** Map RPC / toast errors for khata bill creation paths. */

export function isKhataRedLimitExceededError(message: string | null | undefined): boolean {
  return (message ?? "").includes("khata_red_limit_exceeded");
}

/** Prefer the localized red-limit message; otherwise use fallback (never raw RPC text for this code). */
export function messageForKhataChargeError(
  message: string | null | undefined,
  redLimitMessage: string,
  fallback: string,
): string {
  return isKhataRedLimitExceededError(message) ? redLimitMessage : fallback;
}
