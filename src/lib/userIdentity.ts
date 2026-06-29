import { supabase } from "@/lib/supabase";
import { notifyVendorIdChanged, VENDOR_ACTIVE_CHANGED_EVENT } from "@/lib/vendorSessionSync";

// Phase D: get phone from real Supabase session, strips 91 prefix
async function getSessionPhone(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user?.phone) return null;
  const raw = session.user.phone; // stored as "91XXXXXXXXXX"
  return raw.startsWith('91') && raw.length === 12 ? raw.slice(2) : raw;
}

const PHONE_KEY = "aaspaas:user_phone";
const WELCOMED_KEY = "aaspaas:welcomed";
const VENDOR_ID_KEY = "aaspaas:vendor_id";
const ROLE_KEY = "aaspaas:role";
const VENDOR_ACTIVE_KEY = "aaspaas:vendor_active";

export function hasBeenWelcomed(): boolean {
  try {
    return localStorage.getItem(WELCOMED_KEY) === "true";
  } catch {
    return false;
  }
}

export function markWelcomed(): void {
  try {
    localStorage.setItem(WELCOMED_KEY, "true");
  } catch {
    /* ignore */
  }
}

// Legacy sync path — reads localStorage only.
// Prefer getUserPhoneAsync() in new code where async is possible.
export function getUserPhone(): string | null {
  try {
    return localStorage.getItem(PHONE_KEY) || null;
  } catch {
    return null;
  }
}

export async function getUserPhoneAsync(): Promise<string | null> {
  const sessionPhone = await getSessionPhone();
  if (sessionPhone) return sessionPhone;
  return getUserPhone(); // existing localStorage fallback
}

/**
 * Save user phone number to localStorage.
 * Normalise to 10-digit format (strip +91 / 91 prefix).
 * Returns the new normalized value and the previous stored value (if any).
 */
export function saveUserPhone(raw: string): { normalized: string; previous: string | null } {
  const previous = getUserPhone();
  const cleaned = raw.replace(/\D/g, "");
  const normalized =
    cleaned.length === 12 && cleaned.startsWith("91")
      ? cleaned.slice(2)
      : cleaned.length === 11 && cleaned.startsWith("1")
      ? cleaned.slice(1)
      : cleaned;
  try {
    localStorage.setItem(PHONE_KEY, normalized);
  } catch {
    /* ignore */
  }
  return { normalized, previous };
}

/**
 * Check if user has entered their phone number.
 */
export function isPhoneKnown(): boolean {
  return !!getUserPhone();
}

/**
 * Clear stored phone (for testing / reset).
 */
export function clearUserPhone(): void {
  try {
    localStorage.removeItem(PHONE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Point saved_vendors and requests for this device to the canonical phone (best-effort).
 */
export async function migrateUserPhone(newPhone: string, deviceId: string): Promise<void> {
  const orFilter = `user_phone.is.null,user_phone.neq.${newPhone}`;
  const { error: savedErr } = await supabase
    .from("saved_vendors")
    .update({ user_phone: newPhone })
    .eq("device_id", deviceId)
    .or(orFilter);
  if (savedErr) {
    console.warn("[migrateUserPhone] saved_vendors", savedErr.message);
  }
  const { error: reqErr } = await supabase.rpc("migrate_device_requests_phone", {
    p_device_id: deviceId,
    p_user_phone: newPhone,
  });
  if (reqErr) {
    console.warn("[migrateUserPhone] requests", reqErr.message);
  }
}

/**
 * Silently restore vendor session after account recovery (active, non-deleted vendor only).
 */
export function restoreVendorSession(vendorId: string): void {
  try {
    localStorage.setItem(VENDOR_ID_KEY, vendorId);
    localStorage.setItem(ROLE_KEY, "vendor");
    localStorage.setItem(VENDOR_ACTIVE_KEY, "1");
  } catch {
    /* ignore */
  }
  notifyVendorIdChanged();
  window.dispatchEvent(new CustomEvent(VENDOR_ACTIVE_CHANGED_EVENT, { detail: true }));
}

/**
 * Request a phone OTP via Supabase Auth (triggers sms-hook edge function).
 * In dormant mode (Exotel KYC pending), OTP is logged to _test_otp_capture table.
 * Returns { success: true } or { success: false, error: string }
 */
export async function requestPhoneOtp(
  phone: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.auth.signInWithOtp({
      phone: `+91${phone}`,
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Verify OTP entered by user. On success, a real Supabase session is established
 * (persisted to localStorage via persistSession:true).
 * Returns { success: true } or { success: false, error: string }
 */
export async function verifyPhoneOtp(
  phone: string,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.auth.verifyOtp({
      phone: `+91${phone}`,
      token,
      type: "sms",
    });
    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}
