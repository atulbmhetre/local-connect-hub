import { supabase } from "@/lib/supabase";

const PHONE_KEY = "aaspaas:user_phone";

/**
 * Get stored user phone number, or null if not yet entered.
 */
export function getUserPhone(): string | null {
  try {
    return localStorage.getItem(PHONE_KEY) || null;
  } catch {
    return null;
  }
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
  const { error: reqErr } = await supabase
    .from("requests")
    .update({ user_phone: newPhone })
    .eq("device_id", deviceId)
    .or(orFilter);
  if (reqErr) {
    console.warn("[migrateUserPhone] requests", reqErr.message);
  }
}
