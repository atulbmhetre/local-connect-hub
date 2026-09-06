import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";

const REFERRAL_STORAGE_KEY = "aaspaas:referral_code";
const REFERRAL_PATH_RE = /\/r\/([^/?#]+)/;

function lastFourPhoneDigits(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/** Stable user referral code: USER + last 4 phone digits (e.g. USER2707). */
export function generateUserReferralCode(phone?: string): string {
  const tail = phone ? lastFourPhoneDigits(phone) : null;
  if (tail) return `USER${tail}`;
  const n = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 9000));
  return `USER${n}`;
}

/** Stable vendor referral code from phone: AASP + last 4 digits (registration + Refer & Earn). */
export function referralCodeFromPhone(phone: string): string {
  const tail = lastFourPhoneDigits(phone);
  if (tail) return `AASP${tail}`;
  const n = String(1000 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 9000));
  return `AASP${n}`;
}

function extractReferralCodeFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const path = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const match = path.match(REFERRAL_PATH_RE) ?? window.location.href.match(REFERRAL_PATH_RE);
  const code = match?.[1] ? decodeURIComponent(match[1]).trim() : "";
  return code || null;
}

export function getReferralCode(): string | null {
  try {
    return localStorage.getItem(REFERRAL_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function checkAndStoreReferral(): void {
  try {
    const code = extractReferralCodeFromUrl();
    if (!code) return;
    localStorage.setItem(REFERRAL_STORAGE_KEY, code.toUpperCase());
  } catch {
    // never throws
  }
}

export async function isReferralEnabled(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "referral_enabled")
      .maybeSingle();
    if (error) captureError(error, { scope: "referral.isReferralEnabled" });
    return String(data?.value ?? "").trim().toLowerCase() === "true";
  } catch (err) {
    captureError(err, { scope: "referral.isReferralEnabled" });
    return false;
  }
}

type ApplyUserReferralResult = {
  applied: boolean;
  reason?: string;
  vendor_id?: string;
  referral_id?: string;
  credit_amount?: number;
  vendor_lang?: string;
};

export type RecordUserReferralOutcome = "applied" | "not_applied" | "error";

/**
 * Applies a stored referral code via the atomic apply_user_referral RPC
 * (creates the app_users row if missing and records the vendor reward; a retry
 * completes the reward when a prior attempt created the user but the reward
 * step failed). Returns "applied" | "not_applied" (no/invalid/duplicate code)
 * | "error" (RPC/network failure — worth surfacing to the user).
 *
 * Vendor referral_credit notify is fired by DB trigger on vendor_credits INSERT.
 */
export async function recordUserReferralDetailed(
  phone: string,
  deviceId: string,
): Promise<RecordUserReferralOutcome> {
  try {
    if (!(await isReferralEnabled())) return "not_applied";

    const stored = getReferralCode();
    if (!stored) return "not_applied";

    const { data, error } = await supabase.rpc("apply_user_referral", {
      p_phone: phone,
      p_device_id: deviceId,
      p_referral_code: stored,
    });

    if (error) {
      captureError(error, { scope: "referral.applyUserReferral" });
      return "error";
    }

    const result = (data ?? {}) as ApplyUserReferralResult;
    if (!result.applied || !result.vendor_id) {
      // Not an error: invalid code, self-referral, existing non-referred
      // user, or reward already recorded.
      return "not_applied";
    }

    try {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
    } catch {
      // ignore
    }
    return "applied";
  } catch (err) {
    captureError(err, { scope: "referral.recordUserReferral" });
    return "error";
  }
}

/** Returns true if referral was applied; false on missing code, invalid code, or duplicate. */
export async function recordUserReferral(phone: string, deviceId: string): Promise<boolean> {
  return (await recordUserReferralDetailed(phone, deviceId)) === "applied";
}
