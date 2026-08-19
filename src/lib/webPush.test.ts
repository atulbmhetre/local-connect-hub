import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getTokenMock,
  isSupportedMock,
  persistVendorMock,
  rpcMock,
  isNativeMock,
} = vi.hoisted(() => ({
  getTokenMock: vi.fn(async () => "web-fcm-token"),
  isSupportedMock: vi.fn(async () => true),
  persistVendorMock: vi.fn(async () => undefined),
  rpcMock: vi.fn(async () => ({ error: null })),
  isNativeMock: vi.fn(() => false),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativeMock() },
}));

vi.mock("firebase/app", () => ({
  initializeApp: vi.fn(() => ({})),
  getApps: vi.fn(() => [{}]),
}));

vi.mock("firebase/messaging", () => ({
  getMessaging: vi.fn(() => ({})),
  getToken: getTokenMock,
  isSupported: isSupportedMock,
  onMessage: vi.fn(),
}));

vi.mock("@/lib/pushNotifications", () => ({
  persistVendorPushToken: persistVendorMock,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: rpcMock },
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "web-device-1",
}));

vi.mock("@/lib/firebaseWebConfig", () => ({
  FIREBASE_WEB_CONFIG: {
    apiKey: "test",
    authDomain: "test.firebaseapp.com",
    projectId: "aaspaas-pro",
    storageBucket: "test",
    messagingSenderId: "1",
    appId: "1:1:web:test",
  },
  getFirebaseVapidKey: () => "test-vapid",
  isWebPushConfigReady: () => true,
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import {
  registerWebPushIfPermitted,
  requestWebPushFromUserGesture,
} from "@/lib/webPush";

describe("web push registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isNativeMock.mockReturnValue(false);
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: vi.fn(async () => "granted"),
      },
    });
    Object.defineProperty(globalThis.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: vi.fn(async () => ({})),
        ready: Promise.resolve({}),
      },
    });
  });

  it("no-ops on native (Capacitor path untouched)", async () => {
    isNativeMock.mockReturnValue(true);
    await expect(registerWebPushIfPermitted({ userPhone: "9000000001" })).resolves.toBe(false);
    expect(getTokenMock).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("stores the web FCM token via upsert_user_device", async () => {
    await expect(registerWebPushIfPermitted({ userPhone: "9000000001" })).resolves.toBe(true);
    expect(rpcMock).toHaveBeenCalledWith(
      "upsert_user_device",
      expect.objectContaining({
        p_user_phone: "9000000001",
        p_device_id: "web-device-1",
        p_fcm_token: "web-fcm-token",
      }),
    );
  });

  it("stores vendor web tokens via the existing upsert_vendor_device helper", async () => {
    await registerWebPushIfPermitted({
      vendorId: "v-1",
      vendorPhone: "9888888888",
    });
    expect(persistVendorMock).toHaveBeenCalledWith("v-1", "web-fcm-token", "9888888888");
  });

  it("requestWebPushFromUserGesture prompts then registers", async () => {
    const notification = {
      permission: "default" as NotificationPermission,
      requestPermission: vi.fn(async () => {
        notification.permission = "granted";
        return "granted" as NotificationPermission;
      }),
    };
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: notification,
    });
    await expect(
      requestWebPushFromUserGesture({ userPhone: "9000000001" }),
    ).resolves.toBe(true);
    expect(notification.requestPermission).toHaveBeenCalled();
    expect(getTokenMock).toHaveBeenCalled();
  });
});
