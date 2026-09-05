/**
 * OTP verify/resend helpers.
 *
 * Auth SMS `max_frequency` is 5s in config.toml, but project-level SMS rate
 * limits surface around ~30–40s in practice (see browser OTP helpers). Use a
 * 30s UI cooldown so resend is always offered without hammering Auth.
 */

/** Resend cooldown after a successful OTP send (matches practical Auth SMS cooldown). */
export const OTP_RESEND_COOLDOWN_MS = 30_000;

export type OtpVerifyFailureKind = "expired" | "wrong";

/** Classify Auth verifyOtp errors so expired codes are not shown as "wrong". */
export function classifyOtpVerifyError(
  error: string | null | undefined,
): OtpVerifyFailureKind {
  const msg = String(error ?? "").toLowerCase();
  if (msg.includes("expir")) return "expired";
  return "wrong";
}
