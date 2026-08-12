import { Capacitor } from "@capacitor/core";
import { PushNotifications, type PushNotificationSchema } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Geolocation } from "@capacitor/geolocation";
import { supabase } from "@/lib/supabase";
import { fetchVendorPhone, patchVendorOwn } from "@/lib/vendorPatch";
import { getDeviceId } from "@/lib/deviceId";
import { getAppNavigate } from "@/lib/appNavigate";
import { handlePushNotificationData } from "@/lib/notificationNavigation";
import { storePendingPushNav } from "@/lib/pendingPushNav";
import { captureError } from "@/lib/sentry";

const VENDOR_ID_KEY = "aaspaas:vendor_id";
export const VENDOR_SOUND_KEY = "aaspaas:vendor_sound";
export const VENDOR_VIBRATE_KEY = "aaspaas:vendor_vibrate";

let navigationListenersReady = false;
let registrationListenerAttached = false;
let foregroundListenerAttached = false;

export function isVendorSoundEnabled(): boolean {
  const v = localStorage.getItem(VENDOR_SOUND_KEY);
  return v === null || v === "true";
}

export function isVendorVibrateEnabled(): boolean {
  const v = localStorage.getItem(VENDOR_VIBRATE_KEY);
  return v === null || v === "true";
}

export function setVendorSoundEnabled(enabled: boolean): void {
  localStorage.setItem(VENDOR_SOUND_KEY, enabled ? "true" : "false");
}

export function setVendorVibrateEnabled(enabled: boolean): void {
  localStorage.setItem(VENDOR_VIBRATE_KEY, enabled ? "true" : "false");
}

function vibrateOnOrderPush(role: "vendor" | "user"): void {
  if (role === "vendor" && !isVendorVibrateEnabled()) return;
  if (!("vibrate" in navigator)) return;
  navigator.vibrate([500, 200, 500]);
}

async function showForegroundNotification(notification: PushNotificationSchema): Promise<void> {
  const title =
    notification.title ?? (notification.data?.title as string | undefined) ?? "Aaspaas";
  const body = notification.body ?? (notification.data?.body as string | undefined) ?? "";
  const extra = notification.data ?? {};
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          id: Date.now() % 2147483647,
          title,
          body,
          channelId: "order_alert",
          extra,
        },
      ],
    });
  } catch (err) {
    console.error("Foreground local notification failed", err);
  }
}

export function navigateFromPushData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  const navigate = getAppNavigate();
  if (!navigate) {
    if (typeof data.route === "string" && data.route.trim()) {
      storePendingPushNav(data);
    }
    return;
  }
  handlePushNotificationData(navigate, data);
}

async function ensureNotificationChannels(): Promise<void> {
  await PushNotifications.createChannel({
    id: "order_alert",
    name: "Order Alerts",
    description: "Incoming order notifications",
    importance: 5,
    visibility: 1,
    sound: "default",
    vibration: true,
  });
  await PushNotifications.createChannel({
    id: "default",
    name: "General",
    description: "Feed and general notifications",
    importance: 4,
    visibility: 1,
    sound: "default",
    vibration: true,
  });
}

/**
 * Register tap listeners once at app boot so cold-start notification taps are not lost.
 * Token registration remains in registerPushToken / registerUserPushToken.
 */
export async function initPushNavigationListeners(): Promise<void> {
  if (!Capacitor.isNativePlatform() || navigationListenersReady) return;
  navigationListenersReady = true;

  await ensureNotificationChannels();

  await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    navigateFromPushData(action.notification.data as Record<string, unknown> | undefined);
  });

  await LocalNotifications.addListener("localNotificationActionPerformed", (action) => {
    navigateFromPushData(action.notification.extra as Record<string, unknown> | undefined);
  });
}

async function attachRegistrationListener(
  onToken: (token: string) => Promise<void>,
): Promise<void> {
  if (registrationListenerAttached) return;
  registrationListenerAttached = true;

  await PushNotifications.addListener("registration", async (token) => {
    await onToken(token.value);
  });

  await PushNotifications.addListener("registrationError", (error) => {
    console.error("Push registration failed", error);
    captureError(error, {
      pushSurface: "registration",
      operation: "registrationError",
    });
  });
}

async function setupPushRegistration(
  onToken: (token: string) => Promise<void>,
  role: "vendor" | "user",
): Promise<void> {
  await initPushNavigationListeners();
  await attachRegistrationListener(onToken);
  await PushNotifications.register();

  if (!foregroundListenerAttached) {
    foregroundListenerAttached = true;
    await PushNotifications.addListener("pushNotificationReceived", (notification) => {
      vibrateOnOrderPush(role);
      void showForegroundNotification(notification);
      console.info("Push received in foreground", notification);
    });
  }
}

export type RegisterPushTokenOptions = {
  /** Known vendor phone — skips get_vendor_own lookup (use right after registration). */
  vendorPhone?: string | null;
};

/** Persist FCM token to vendor_devices (+ vendors.fcm_token mirror). */
export async function persistVendorPushToken(
  vendorId: string,
  tokenValue: string,
  vendorPhone: string,
): Promise<void> {
  const phone = vendorPhone.trim();
  if (!phone) {
    console.error("Push token save failed: vendor phone missing");
    return;
  }
  const deviceId = getDeviceId();

  const { error } = await supabase.rpc("upsert_vendor_device", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_device_id: deviceId,
    p_fcm_token: tokenValue,
    p_last_lat: null,
    p_last_lng: null,
  });
  if (error) {
    console.error("Vendor push device save failed", error);
    captureError(error, {
      pushSurface: "registration",
      operation: "upsert_vendor_device",
      vendorId,
    });
    return;
  }

  const { error: patchError } = await patchVendorOwn(vendorId, phone, {
    fcm_token: tokenValue,
  });
  if (patchError) {
    console.error("Push token save failed", patchError);
    captureError(patchError, {
      pushSurface: "registration",
      operation: "patchVendorOwn.fcm_token",
      vendorId,
    });
  }
}

export async function registerPushToken(
  vendorId: string,
  options?: RegisterPushTokenOptions,
) {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  const knownPhone = options?.vendorPhone?.trim() || null;

  await setupPushRegistration(async (tokenValue) => {
    const vendorPhone = knownPhone || (await fetchVendorPhone(vendorId));
    if (!vendorPhone) {
      console.error("Push token save failed: vendor phone not found");
      return;
    }
    await persistVendorPushToken(vendorId, tokenValue, vendorPhone);
  }, "vendor");
}

async function saveUserDeviceLocationSilently(userPhone: string, deviceId: string): Promise<void> {
  try {
    await Geolocation.requestPermissions();
    const pos = await Geolocation.getCurrentPosition({ timeout: 10_000 });
    const { error } = await supabase.rpc("update_user_device_location", {
      p_user_phone: userPhone,
      p_device_id: deviceId,
      p_last_lat: pos.coords.latitude,
      p_last_lng: pos.coords.longitude,
    });
    if (error) throw error;
  } catch {
    /* best-effort silent */
  }
}

/**
 * Always invoke the OS notification permission prompt on native.
 * Call this from FirstOpen "Allow" even when no phone is on file yet so Settings
 * reflects real OS state (fixes checkbox / permission mismatch).
 */
export async function requestPushPermissionFromOs(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  const permission = await PushNotifications.requestPermissions();
  return permission.receive === "granted";
}

export async function registerUserPushToken(
  userPhone: string,
  options?: { skipPermissionRequest?: boolean },
) {
  if (!Capacitor.isNativePlatform()) return;

  if (!options?.skipPermissionRequest) {
    const granted = await requestPushPermissionFromOs();
    if (!granted) {
      captureError(new Error("push_permission_denied"), {
        pushSurface: "registration",
        operation: "registerUserPushToken",
        reason: "permission_denied",
      });
      return;
    }
  }

  const deviceId = getDeviceId();

  await setupPushRegistration(async (tokenValue) => {
    const { error } = await supabase.rpc("upsert_user_device", {
      p_user_phone: userPhone,
      p_device_id: deviceId,
      p_fcm_token: tokenValue,
      p_last_lat: null,
      p_last_lng: null,
    });
    if (error) {
      console.error("User push token save failed", error);
      captureError(error, {
        pushSurface: "registration",
        operation: "upsert_user_device",
      });
      return;
    }
    void saveUserDeviceLocationSilently(userPhone, deviceId);
  }, "user");
}
