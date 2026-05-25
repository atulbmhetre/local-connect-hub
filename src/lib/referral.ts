import { supabase } from "@/lib/supabase";

const REFERRAL_STORAGE_KEY = "aaspaas:referral_code";
const REFERRAL_PATH_RE = /\/r\/([^/?#]+)/;

/** Random 8-char alphanumeric code for the user's own referral code (Phase 3). */
function generateUserCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i]! % chars.length];
  }
  return code;
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

export async function recordUserReferral(phone: string, deviceId: string): Promise<void> {
  try {
    const stored = getReferralCode();
    if (!stored) return;

    const { data: vendor, error: vendorError } = await supabase
      .from("vendors")
      .select("id")
      .eq("referral_code", stored)
      .maybeSingle();

    if (vendorError || !vendor) return;

    const { error: userError } = await supabase.from("app_users").insert({
      phone,
      device_id: deviceId,
      referral_code: generateUserCode(),
      referred_by_vendor_id: vendor.id,
    });

    if (userError) return;

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

    if (referralError || !referral) return;

    const { error: creditError } = await supabase.from("vendor_credits").insert({
      vendor_id: vendor.id,
      referral_id: referral.id,
      amount: 2.5,
      disbursement_month: 1,
      disbursed: false,
    });

    if (creditError) return;

    try {
      localStorage.removeItem(REFERRAL_STORAGE_KEY);
    } catch {
      // ignore
    }
  } catch {
    // never throws
  }
}
