import { Capacitor } from "@capacitor/core";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { initializeApp, getApps } from "firebase/app";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { persistVendorPushToken } from "@/lib/pushNotifications";
import { captureError } from "@/lib/sentry";
import {
  FIREBASE_WEB_CONFIG,
  getFirebaseVapidKey,
  isWebPushConfigReady,
} from "@/lib/firebaseWebConfig";
import { handlePushNotificationData } from "@/lib/notificationNavigation";
import { getAppNavigate } from "@/lib/appNavigate";
import { storePendingPushNav } from "@/lib/pendingPushNav";

let messagingReady = false;
let foregroundListenerAttached = false;

function firebaseApp() {
  const existing = getApps()[0];
  return existing ?? initializeApp(FIREBASE_WEB_CONFIG);
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  await navigator.serviceWorker.register("/firebase-messaging-sw.js");
  return navigator.serviceWorker.ready;
}

async function persistUserWebToken(userPhone: string, token: string): Promise<void> {
  const { error } = await supabase.rpc("upsert_user_device", {
    p_user_phone: userPhone,
    p_device_id: getDeviceId(),
    p_fcm_token: token,
    p_last_lat: null,
    p_last_lng: null,
  });
  if (error) {
    console.error("Web push user token save failed", error);
    captureError(error, {
      pushSurface: "registration",
      operation: "upsert_user_device.web",
    });
  }
}

async function obtainWebFcmToken(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) return null;
  if (!isWebPushConfigReady()) return null;
  if (typeof Notification === "undefined") return null;
  if (Notification.permission !== "granted") {
    console.warn("Web FCM skipped: notification permission is", Notification.permission);
    return null;
  }
  const supported = await isSupported().catch(() => false);
  if (!supported) {
    console.warn("Web FCM skipped: Firebase Messaging isSupported() is false");
    return null;
  }

  const vapidKey = getFirebaseVapidKey();
  const registration = await ensureServiceWorker();
  if (!registration) return null;

  firebaseApp();
  const messaging = getMessaging();
  messagingReady = true;

  if (!foregroundListenerAttached) {
    foregroundListenerAttached = true;
    onMessage(messaging, (payload) => {
      const data = (payload.data ?? {}) as Record<string, unknown>;
      const title =
        payload.notification?.title ||
        (typeof data.title === "string" ? data.title : "Aaspaas");
      const body =
        payload.notification?.body || (typeof data.body === "string" ? data.body : "");
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(title, { body, data });
      }
    });
  }

  try {
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    return token?.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no active Service Worker|AbortError/i.test(message)) {
      const retryReg = await ensureServiceWorker();
      if (retryReg) {
        try {
          const token = await getToken(messaging, {
            vapidKey,
            serviceWorkerRegistration: retryReg,
          });
          return token?.trim() || null;
        } catch (retryErr) {
          console.error("Web FCM getToken retry failed", retryErr);
          captureError(retryErr, { pushSurface: "registration", operation: "web.getToken.retry" });
          return null;
        }
      }
    }
    console.error("Web FCM getToken failed", err);
    captureError(err, { pushSurface: "registration", operation: "web.getToken" });
    return null;
  }
}

/** Register an already-granted web token. Does not prompt. */
export async function registerWebPushIfPermitted(opts: {
  userPhone?: string | null;
  vendorId?: string | null;
  vendorPhone?: string | null;
}): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return false;
  const token = await obtainWebFcmToken();
  if (!token) return false;
  const userPhone = opts.userPhone?.trim();
  if (userPhone) await persistUserWebToken(userPhone, token);
  const vendorId = opts.vendorId?.trim();
  const vendorPhone = opts.vendorPhone?.trim();
  if (vendorId && vendorPhone) {
    await persistVendorPushToken(vendorId, token, vendorPhone);
  }
  return true;
}

/**
 * User-gesture entry: Notification.requestPermission() then FCM getToken
 * via existing upsert_user_device / upsert_vendor_device RPCs.
 */
export async function requestWebPushFromUserGesture(opts: {
  userPhone?: string | null;
  vendorId?: string | null;
  vendorPhone?: string | null;
}): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return false;
  if (!isWebPushConfigReady()) return false;
  if (typeof Notification === "undefined") return false;
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  return registerWebPushIfPermitted(opts);
}

export function consumeWebPushNotificationClick(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  const navigate = getAppNavigate();
  if (!navigate) {
    storePendingPushNav(data);
    return;
  }
  handlePushNotificationData(navigate, data);
}

export function isWebPushMessagingReadyForTests(): boolean {
  return messagingReady;
}
