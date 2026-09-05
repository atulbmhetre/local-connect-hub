import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStart, mockStop, mockPatch, mockInvokeNotifyUser, isNativeMock } = vi.hoisted(() => ({
  mockStart: vi.fn(async () => undefined),
  mockStop: vi.fn(async () => undefined),
  mockPatch: vi.fn(async () => ({ error: null })),
  mockInvokeNotifyUser: vi.fn(),
  isNativeMock: vi.fn(() => false),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNativeMock() },
}));

vi.mock("@capgo/background-geolocation", () => ({
  BackgroundGeolocation: {
    start: mockStart,
    stop: mockStop,
  },
}));

vi.mock("@capacitor/geolocation", () => ({
  Geolocation: {
    getCurrentPosition: vi.fn(async () => ({
      coords: { latitude: 18.52, longitude: 73.86 },
    })),
  },
}));

vi.mock("@/lib/vendorPatch", () => ({
  patchVendorOwn: mockPatch,
}));

vi.mock("@/lib/nativePermissions", () => ({
  ensureHelpTrackingPermissions: vi.fn(async () => ({
    location: "granted",
    backgroundLocation: "granted",
    notifications: "granted",
  })),
  isPermissionGranted: (status: string) => status === "granted" || status === "limited",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          eq: () => ({ data: [], error: null }),
        }),
      }),
    }),
    rpc: vi.fn(async () => ({ data: null, error: null })),
  },
  invokeNotifyUser: mockInvokeNotifyUser,
}));

import {
  getActiveTrackingSourcesForTests,
  isHelpStoppedHeartbeatRunningForTests,
  startHelpLiveTracking,
  startOrderTracking,
  stopAllVendorLocationTracking,
  stopHelpLiveTracking,
  stopOrderTracking,
  syncHelpAcceptedOrderTracking,
  VENDOR_STOPPED_HEARTBEAT_MS,
} from "@/lib/vendorBackgroundLocation";
import { sendIveStartedCustomerNotification } from "@/lib/iveStartedNotify";
import { iveStartedActionStartsTracking } from "@/lib/vendorTrackingPolicy";

const store = new Map<string, string>();

beforeEach(async () => {
  store.clear();
  mockStart.mockClear();
  mockStop.mockClear();
  mockPatch.mockClear();
  mockInvokeNotifyUser.mockClear();
  isNativeMock.mockReturnValue(false);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
  await stopAllVendorLocationTracking();
});

describe("vendorBackgroundLocation sources", () => {
  const ctx = { vendorId: "v1", vendorPhone: "9000000001" };

  it("case 1: help-live start/stop", async () => {
    await startHelpLiveTracking(ctx);
    expect(getActiveTrackingSourcesForTests()).toEqual(["help-live"]);
    await stopHelpLiveTracking();
    expect(getActiveTrackingSourcesForTests()).toEqual([]);
  });

  it("cases 2/3: order source start/stop independently of help", async () => {
    await startHelpLiveTracking(ctx);
    await startOrderTracking("ord-asap", ctx);
    expect(getActiveTrackingSourcesForTests()).toEqual(["help-live", "order:ord-asap"]);
    await stopOrderTracking("ord-asap");
    expect(getActiveTrackingSourcesForTests()).toEqual(["help-live"]);
    await stopHelpLiveTracking();
    expect(getActiveTrackingSourcesForTests()).toEqual([]);
  });

  it("cases 4/5: I've Started notifies only and never adds a tracking source", async () => {
    expect(iveStartedActionStartsTracking()).toBe(false);
    const before = getActiveTrackingSourcesForTests();
    const result = await sendIveStartedCustomerNotification({
      order: {
        id: "sched-1",
        status: "accepted",
        delivery_slot: "tomorrow",
      },
      userPhone: "9111111111",
      vendorId: "vendor-1",
      vendorPhone: "9888888888",
    });
    expect(result.ok).toBe(true);
    expect(mockInvokeNotifyUser).not.toHaveBeenCalled();
    expect(getActiveTrackingSourcesForTests()).toEqual(before);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("cases 4/5 appointment: I've Started does not call BackgroundGeolocation.start", async () => {
    await sendIveStartedCustomerNotification({
      order: {
        id: "sched-appt",
        status: "accepted",
        created_at: "2026-07-11T10:00:00.000Z",
        appointment_time: "2026-07-20T15:00:00.000Z",
        appointment_status: "confirmed",
      },
      userPhone: "9222222222",
      vendorId: "vendor-2",
      vendorPhone: "9777777777",
    });
    expect(mockInvokeNotifyUser).not.toHaveBeenCalled();
    expect(getActiveTrackingSourcesForTests()).toEqual([]);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("native start uses requestPermissions: false and only ensures missing perms on go-live", async () => {
    const { ensureHelpTrackingPermissions } = await import("@/lib/nativePermissions");
    isNativeMock.mockReturnValue(true);

    await startHelpLiveTracking(ctx);
    expect(ensureHelpTrackingPermissions).not.toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ requestPermissions: false }),
      expect.any(Function),
    );

    await stopHelpLiveTracking();
    mockStart.mockClear();
    vi.mocked(ensureHelpTrackingPermissions).mockClear();

    await startHelpLiveTracking(ctx, { requestMissingPermissions: true });
    expect(ensureHelpTrackingPermissions).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({ requestPermissions: false }),
      expect.any(Function),
    );

    await stopHelpLiveTracking();
    isNativeMock.mockReturnValue(false);
  });

  it("returns false when native BackgroundGeolocation.start fails (M7)", async () => {
    isNativeMock.mockReturnValue(true);
    mockStart.mockRejectedValueOnce(new Error("permission denied"));
    const ok = await startHelpLiveTracking(ctx, { requestMissingPermissions: true });
    expect(ok).toBe(false);
    await stopHelpLiveTracking();
    isNativeMock.mockReturnValue(false);
  });
});

describe("help live GPS heartbeat", () => {
  const ctx = { vendorId: "v1", vendorPhone: "9000000001" };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs periodic GPS writes when Help Go-Live is on, even with no accepted order", async () => {
    await startHelpLiveTracking(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(true);
    expect(mockPatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(VENDOR_STOPPED_HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockPatch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("pauses heartbeat while the tab is hidden and resumes when visible", async () => {
    await startHelpLiveTracking(ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(true);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(false);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(true);
  });

  it("does not heartbeat without Go-Live even if Help orders are accepted", async () => {
    syncHelpAcceptedOrderTracking(["help-ord-2"], ctx);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(false);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
