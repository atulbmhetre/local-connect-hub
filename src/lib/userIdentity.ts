import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { captureError } from "@/lib/sentry";
import { notifyVendorIdChanged, reconcileVendorActiveFlag } from "@/lib/vendorSessionSync";
import {
  applyAbortSignal,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";

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

/** localStorage does not fire the `storage` event in the same tab; Home surfaces listen for this. */
export const USER_PHONE_CHANGED_EVENT = "aaspaas:user_phone_changed";

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
 * Best-effort phone↔device row in user_devices (no FCM / push permission needed).
 * Safe on web and native. Does not clear an existing fcm_token.
 */
export async function ensureUserDeviceLink(phone: string): Promise<void> {
  const trimmed = phone.trim();
  if (!trimmed) return;
  try {
    const { error } = await withTimedRetry(async (signal) =>
      throwOnSupabaseNetworkError(
        await applyAbortSignal(
          supabase.rpc("ensure_user_device_link", {
            p_user_phone: trimmed,
            p_device_id: getDeviceId(),
          }),
          signal,
        ),
      ),
    );
    if (error) {
      console.warn("[ensureUserDeviceLink]", error.message);
      captureError(error, {
        scope: "userIdentity.ensureUserDeviceLink",
        phoneSuffix: trimmed.slice(-4),
      });
    }
  } catch (err) {
    console.warn("[ensureUserDeviceLink]", err);
    captureError(err, {
      scope: "userIdentity.ensureUserDeviceLink",
      phoneSuffix: trimmed.slice(-4),
    });
  }
}

/**
 * Save user phone number to localStorage.
 * Normalise to 10-digit format (strip +91 / 91 prefix).
 * Returns the new normalized value and the previous stored value (if any).
 * Also best-effort links this device to the phone for delete-account ownership.
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
  void ensureUserDeviceLink(normalized);
  try {
    window.dispatchEvent(new CustomEvent(USER_PHONE_CHANGED_EVENT, { detail: normalized }));
  } catch {
    /* ignore (SSR / non-browser) */
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

export type MigrateUserPhoneResult = {
  ok: boolean;
  savedOk: boolean;
  requestsOk: boolean;
};

/**
 * Point saved_vendors and requests for this device to the canonical phone (best-effort).
 */
export async function migrateUserPhone(
  newPhone: string,
  deviceId: string,
): Promise<MigrateUserPhoneResult> {
  let savedOk = false;
  let requestsOk = false;

  try {
    const saved = await withTimedRetry(async (signal) =>
      throwOnSupabaseNetworkError(
        await applyAbortSignal(
          supabase.rpc("migrate_saved_vendors_phone", {
            p_device_id: deviceId,
            p_user_phone: newPhone,
          }),
          signal,
        ),
      ),
    );
    if (saved.error) {
      console.warn("[migrateUserPhone] saved_vendors", saved.error.message);
      captureError(saved.error, {
        scope: "userIdentity.migrateUserPhone.saved_vendors",
        phoneSuffix: newPhone.slice(-4),
      });
    } else {
      savedOk = true;
    }
  } catch (err) {
    console.warn("[migrateUserPhone] saved_vendors", err);
    captureError(err, {
      scope: "userIdentity.migrateUserPhone.saved_vendors",
      phoneSuffix: newPhone.slice(-4),
    });
  }

  try {
    const req = await withTimedRetry(async (signal) =>
      throwOnSupabaseNetworkError(
        await applyAbortSignal(
          supabase.rpc("migrate_device_requests_phone", {
            p_device_id: deviceId,
            p_user_phone: newPhone,
          }),
          signal,
        ),
      ),
    );
    if (req.error) {
      console.warn("[migrateUserPhone] requests", req.error.message);
      captureError(req.error, {
        scope: "userIdentity.migrateUserPhone.requests",
        phoneSuffix: newPhone.slice(-4),
      });
    } else {
      requestsOk = true;
    }
  } catch (err) {
    console.warn("[migrateUserPhone] requests", err);
    captureError(err, {
      scope: "userIdentity.migrateUserPhone.requests",
      phoneSuffix: newPhone.slice(-4),
    });
  }

  return { ok: savedOk && requestsOk, savedOk, requestsOk };
}

/**
 * Silently restore vendor session after account recovery.
 * `isActive` must match the restored row (`get_vendor_restore_status.is_active`)
 * so BottomNav shows ME·Online / ME·Offline immediately — not a hardcoded live flag.
 */
export function restoreVendorSession(vendorId: string, isActive: boolean): void {
  try {
    localStorage.setItem(VENDOR_ID_KEY, vendorId);
    localStorage.setItem(ROLE_KEY, "vendor");
  } catch {
    /* ignore */
  }
  reconcileVendorActiveFlag(isActive);
  notifyVendorIdChanged();
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
