/**
 * Canonical Indian mobile normalize + validate for the app client.
 * Aligns with SQL CHECKs / RPC phone gates: 10 digits, leading 6–9
 * (`^[6-9][0-9]{9}$` after normalize).
 *
 * Always prefer these helpers over ad-hoc replace(/\D/g) or local "91" stripping.
 */

/** SQL / app mobile shape after normalize. */
export const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

/**
 * Strip non-digits, then reduce to a 10-digit national number when possible:
 * - 12 digits starting with 91 → drop country code
 * - already 10 digits → keep
 * - longer digit string starting with 91 → last 10 (Auth-style)
 * Otherwise null (empty / too short / no usable 10-digit form).
 *
 * Does not enforce leading 6–9 — use {@link isValidIndianMobile} for that.
 */
export function normalizePhoneDigits(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 10) return digits;
  if (digits.length > 10 && digits.startsWith("91")) return digits.slice(-10);
  return null;
}

/** Alias used by Auth / session comparison paths. */
export const normalizeAuthPhone = normalizePhoneDigits;

/**
 * True when raw normalizes to a 10-digit Indian mobile (leading 6–9).
 * Accepts "+91 …", "91…", spaced/dashed forms, or already-normalized digits.
 */
export function isValidIndianMobile(raw: string | null | undefined): boolean {
  const ten = normalizePhoneDigits(raw);
  return ten != null && INDIAN_MOBILE_RE.test(ten);
}

/** Historical name — same rule as {@link isValidIndianMobile}. */
export const isValidPhone = isValidIndianMobile;

/**
 * Same person / same account phone — compares canonical 10-digit forms.
 * "+91 98…", "9198…", and "98…" are equal when the national number matches.
 */
export function isSamePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  return da != null && db != null && da === db;
}
