import { supabase, invokeNotifyVendor } from "@/lib/supabase";
import { strings, type Language } from "@/lib/strings";

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
    const { data } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "referral_enabled")
      .maybeSingle();
    return String(data?.value ?? "").trim().toLowerCase() === "true";
  } catch {
    return false;
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

function referralNotifyCopy(): { title: string; body: (amount: number) => string } {
  try {
    const stored = localStorage.getItem("aaspaas:language");
    const lang: Language = stored === "hi" || stored === "mr" ? stored : "en";
    return strings[lang];
  } catch {
    return strings.en;
  }
}

/** Returns true if referral was applied; false on missing code, invalid code, or duplicate. */
export async function recordUserReferral(phone: string, deviceId: string): Promise<boolean> {
  try {
    if (!(await isReferralEnabled())) return false;

    const stored = getReferralCode();
    if (!stored) return false;

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select("id, phone")
      .eq("referral_code", stored)
      .maybeSingle();

    if (vendorError || !vendor) return false;

    const normalise = (p: string) => p.replace(/\D/g, "").slice(-10);
    const vendorPhone = vendor.phone ?? "";
    if (normalise(vendorPhone) === normalise(phone)) {
      console.warn("Self-referral blocked");
      return false;
    }

    const { data: userCreated, error: userError } = await supabase.rpc(
      "create_referred_user",
      {
        p_phone: phone,
        p_device_id: deviceId,
        p_referral_code: stored,
        p_referred_by_vendor_id: vendor.id,
      },
    );

    if (userError || !userCreated) return false;

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

    const { error: referralUpdateError } = await supabase
      .from("referrals")
      .update({ credits_created: true })
      .eq("id", referral.id);

    if (referralUpdateError) return false;

    // Session 42B violation: client-triggered notify — move to DB trigger post-launch.
    const notifyStrings = referralNotifyCopy();
    void invokeNotifyVendor({
      vendor_id: vendor.id,
      type: "referral_credit",
      notification_title: notifyStrings.feed_referralCredit_title,
      message: notifyStrings.feed_referralCredit_body(creditAmount),
      route: "vendor",
      route_params: { vendor_id: vendor.id },
    });

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
