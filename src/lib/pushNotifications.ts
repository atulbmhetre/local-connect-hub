import { Capacitor } from "@capacitor/core";
import { PushNotifications, type PushNotificationSchema } from "@capacitor/push-notifications";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Geolocation } from "@capacitor/geolocation";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";

const VENDOR_ID_KEY = "aaspaas:vendor_id";
export const VENDOR_SOUND_KEY = "aaspaas:vendor_sound";
export const VENDOR_VIBRATE_KEY = "aaspaas:vendor_vibrate";

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
  // Vendors can mute the buzz in settings; customer pushes always vibrate.
  if (role === "vendor" && !isVendorVibrateEnabled()) return;
  if (!("vibrate" in navigator)) return;
  navigator.vibrate([500, 200, 500]);
}

/**
 * Android FCM does not display a system notification for pushes that arrive
 * while the app is in foreground — schedule a local one so it's visible.
 */
async function showForegroundNotification(notification: PushNotificationSchema): Promise<void> {
  const title =
    notification.title ?? (notification.data?.title as string | undefined) ?? "Aaspaas";
  const body = notification.body ?? (notification.data?.body as string | undefined) ?? "";
  try {
    await LocalNotifications.schedule({
      notifications: [
        {
          // Java int range; collisions within the same ms are practically impossible here.
          id: Date.now() % 2147483647,
          title,
          body,
          channelId: "order_alert",
        },
      ],
    });
  } catch (err) {
    console.error("Foreground local notification failed", err);
  }
}

async function handleLocationPing(data: Record<string, string> | undefined): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (data?.type !== "location_ping") return;

  const vendorId = localStorage.getItem(VENDOR_ID_KEY);
  if (!vendorId) return;

  try {
    const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
      if (!("geolocation" in navigator)) {
        reject(new Error("Geolocation not supported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0,
      });
    });

    await supabase
      .from("vendors")
      .update({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        last_updated: new Date().toISOString(),
      })
      .eq("id", vendorId);
  } catch {
    /* best-effort silent ping */
  }
}

async function setupPushListeners(
  onToken: (token: string) => Promise<void>,
  role: "vendor" | "user",
): Promise<void> {
  await PushNotifications.createChannel({
    id: "order_alert",
    name: "Order Alerts",
    description: "Incoming order notifications",
    importance: 5,
    visibility: 1,
    sound: "default",
    vibration: true,
  });

  await PushNotifications.register();
  await PushNotifications.removeAllListeners();

  await PushNotifications.addListener("registration", async (token) => {
    await onToken(token.value);
  });

  await PushNotifications.addListener("registrationError", (error) => {
    console.error("Push registration failed", error);
  });

  await PushNotifications.addListener("pushNotificationReceived", (notification) => {
    void handleLocationPing(notification.data);
    if (notification.data?.type === "location_ping") return;
    vibrateOnOrderPush(role);
    void showForegroundNotification(notification);
    console.info("Push received in foreground", notification);
  });

  await PushNotifications.addListener("pushNotificationActionPerformed", (action) => {
    console.info("Push tapped", action);
  });
}

export async function registerPushToken(vendorId: string) {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  await setupPushListeners(async (tokenValue) => {
    const { error } = await supabase
      .from("vendors")
      .update({ fcm_token: tokenValue })
      .eq("id", vendorId);
    if (error) {
      console.error("Push token save failed", error);
    }
  }, "vendor");
}

/**
 * Best-effort GPS snapshot for user_devices; never throws or surfaces errors.
 * Upserts on (user_phone, device_id) so the write lands even if the device
 * row doesn't exist yet; the token upsert later fills fcm_token on the same row.
 */
async function saveUserDeviceLocationSilently(userPhone: string, deviceId: string): Promise<void> {
  try {
    await Geolocation.requestPermissions();
    const pos = await Geolocation.getCurrentPosition({ timeout: 10_000 });
    // Row already exists from the FCM token upsert above. Do not use upsert here:
    // user_devices.fcm_token is NOT NULL, and PostgREST upsert validates the INSERT
    // candidate (null fcm_token) before ON CONFLICT, so the write silently fails.
    const { error } = await supabase
      .from("user_devices")
      .update({
        last_lat: pos.coords.latitude,
        last_lng: pos.coords.longitude,
        last_location_at: new Date().toISOString(),
      })
      .eq("user_phone", userPhone)
      .eq("device_id", deviceId);
    if (error) throw error;
  } catch {
    /* best-effort silent */
  }
}

export async function registerUserPushToken(userPhone: string) {
  if (!Capacitor.isNativePlatform()) return;

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") return;

  const deviceId = getDeviceId();

  await setupPushListeners(async (tokenValue) => {
    const { error } = await supabase.from("user_devices").upsert(
      {
        user_phone: userPhone,
        device_id: deviceId,
        fcm_token: tokenValue,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_phone,device_id" },
    );
    if (error) {
      console.error("User push token save failed", error);
      return;
    }
    void saveUserDeviceLocationSilently(userPhone, deviceId);
  }, "user");
}
