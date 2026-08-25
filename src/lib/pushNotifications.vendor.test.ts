import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  rpcMock,
  patchVendorOwnMock,
  fetchVendorPhoneMock,
  isNativeMock,
  requestPermissionsMock,
  registerMock,
  addListenerMock,
} = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  patchVendorOwnMock: vi.fn(),
  fetchVendorPhoneMock: vi.fn(),
  isNativeMock: vi.fn(() => true),
  requestPermissionsMock: vi.fn(async () => ({ receive: "granted" as const })),
  registerMock: vi.fn(async () => undefined),
  addListenerMock: vi.fn(async (_event: string, cb?: (arg: { value: string }) => void) => {
    if (_event === "registration" && cb) {
      await cb({ value: "test-fcm-token" });
    }
  }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: isNativeMock },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    requestPermissions: requestPermissionsMock,
    register: registerMock,
    addListener: addListenerMock,
    createChannel: vi.fn(async () => undefined),
  },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    addListener: vi.fn(async () => undefined),
  },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: rpcMock },
}));

vi.mock("@/lib/vendorPatch", () => ({
  fetchVendorPhone: fetchVendorPhoneMock,
  patchVendorOwn: patchVendorOwnMock,
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device-id",
}));

vi.mock("@/lib/sentry", () => ({
  captureError: vi.fn(),
}));

vi.mock("@/lib/nativePermissions", () => ({
  ensureNativePermissionGranted: vi.fn(async () => true),
  checkNativePermissionStatuses: vi.fn(async () => ({
    notifications: "granted",
    location: "granted",
    backgroundLocation: "granted",
    camera: "granted",
    microphone: "granted",
  })),
  isPermissionGranted: (status: string) => status === "granted" || status === "limited",
}));

import { persistVendorPushToken, registerPushToken } from "@/lib/pushNotifications";
import { ensureNativePermissionGranted } from "@/lib/nativePermissions";

describe("persistVendorPushToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ error: null });
    patchVendorOwnMock.mockResolvedValue({ error: null });
  });

  it("upserts vendor_devices and mirrors vendors.fcm_token", async () => {
    await persistVendorPushToken("vendor-1", "token-abc", "9900012345");

    expect(rpcMock).toHaveBeenCalledWith("upsert_vendor_device", {
      p_vendor_id: "vendor-1",
      p_vendor_phone: "9900012345",
      p_device_id: "test-device-id",
      p_fcm_token: "token-abc",
      p_last_lat: null,
      p_last_lng: null,
    });
    expect(patchVendorOwnMock).toHaveBeenCalledWith("vendor-1", "9900012345", {
      fcm_token: "token-abc",
    });
    expect(fetchVendorPhoneMock).not.toHaveBeenCalled();
  });
});

describe("registerPushToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rpcMock.mockResolvedValue({ error: null });
    patchVendorOwnMock.mockResolvedValue({ error: null });
    fetchVendorPhoneMock.mockResolvedValue("9900099999");
  });

  it("uses vendorPhone option without fetchVendorPhone lookup", async () => {
    await registerPushToken("vendor-2", { vendorPhone: "9900011111" });

    expect(fetchVendorPhoneMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith(
      "upsert_vendor_device",
      expect.objectContaining({
        p_vendor_id: "vendor-2",
        p_vendor_phone: "9900011111",
        p_fcm_token: "test-fcm-token",
      }),
    );
  });

  it("no-ops on web (non-native)", async () => {
    isNativeMock.mockReturnValueOnce(false);
    await registerPushToken("vendor-3", { vendorPhone: "9900022222" });
    expect(registerMock).not.toHaveBeenCalled();
  });

  it("does not register when live-check does not grant notification permission", async () => {
    vi.mocked(ensureNativePermissionGranted).mockResolvedValueOnce(false);
    await registerPushToken("vendor-4", { vendorPhone: "9900033333" });
    expect(ensureNativePermissionGranted).toHaveBeenCalledWith("notifications", "passive");
    expect(registerMock).not.toHaveBeenCalled();
  });
});
