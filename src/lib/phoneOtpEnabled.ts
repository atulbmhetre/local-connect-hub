/** Phase D: OTP gates phone registration when true (TEST / dev). */
export const OTP_ENABLED = import.meta.env.VITE_OTP_ENABLED === "true";

export function normalizePhoneDigits(raw: string): string {
  const cleaned = raw.replace(/\D/g, "");
  return cleaned.length === 12 && cleaned.startsWith("91")
    ? cleaned.slice(2)
    : cleaned;
}

export function isValidIndianMobile(digits: string): boolean {
  return digits.length === 10 && /^[6-9]/.test(digits);
}
