import { supabase } from "@/lib/supabase";

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

/** Stable vendor referral code from phone when DB has no referral_code yet: AASP + last 4 digits. */
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
    localStorage.setItem(REFERRAL_STORAGE_KEY, code);
  } catch {
    // never throws
  }
}

let cachedReferralUserCredit: number | null = null;

async function getReferralUserCreditAmount(): Promise<number> {
  if (cachedReferralUserCredit != null) return cachedReferralUserCredit;
  try {
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "referral_user_credit")
      .maybeSingle();
    const n = Number(String(data?.value ?? "").trim());
    cachedReferralUserCredit = Number.isFinite(n) ? n : 2.5;
  } catch {
    cachedReferralUserCredit = 2.5;
  }
  return cachedReferralUserCredit;
}

/** Returns true if referral was applied; false on missing code, invalid code, or duplicate. */
export async function recordUserReferral(phone: string, deviceId: string): Promise<boolean> {
  try {
    const stored = getReferralCode();
    if (!stored) return false;

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select("id")
      .eq("referral_code", stored)
      .maybeSingle();

    if (vendorError || !vendor) return false;

    const { error: userError } = await supabase.from("app_users").insert({
      phone,
      device_id: deviceId,
      referral_code: generateUserReferralCode(phone),
      referred_by_vendor_id: vendor.id,
    });

    if (userError) return false;

    const triggeredAt = new Date().toISOString();

    const { data: referral, error: referralError } = await supabase
      .from("referrals")
      .insert({
        referrer_vendor_id: vendor.id,
        referee_type: "user",
        referee_id: phone,
        status: "active",
        trigger_rule: "active_once",
        triggered_at: triggeredAt,
        credits_created: false,
      })
      .select("id")
      .single();

    if (referralError || !referral) return false;

    const creditAmount = await getReferralUserCreditAmount();

    const { error: creditError } = await supabase.from("vendor_credits").insert({
      vendor_id: vendor.id,
      referral_id: referral.id,
      amount: creditAmount,
      disbursement_month: 1,
      disbursed: false,
    });

    if (creditError) return false;

    try {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
    } catch {
      // ignore
    }
    return true;
  } catch {
    return false;
  }
}
