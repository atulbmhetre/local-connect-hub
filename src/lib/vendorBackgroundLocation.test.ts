import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockStart, mockStop, mockPatch, mockInvokeNotifyUser } = vi.hoisted(() => ({
  mockStart: vi.fn(async () => undefined),
  mockStop: vi.fn(async () => undefined),
  mockPatch: vi.fn(async () => ({ error: null })),
  mockInvokeNotifyUser: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
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
  },
  invokeNotifyUser: mockInvokeNotifyUser,
}));

import {
  getActiveTrackingSourcesForTests,
  getHelpAcceptedOrderIdsForTests,
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
    });
    expect(result.ok).toBe(true);
    expect(mockInvokeNotifyUser).toHaveBeenCalledTimes(1);
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
    });
    expect(mockInvokeNotifyUser).toHaveBeenCalled();
    expect(getActiveTrackingSourcesForTests()).toEqual([]);
    expect(mockStart).not.toHaveBeenCalled();
  });
});

describe("help stopped-detection heartbeat", () => {
  const ctx = { vendorId: "v1", vendorPhone: "9000000001" };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs periodic GPS writes when Go-Live and accepted Help orders exist", async () => {
    await startHelpLiveTracking(ctx);
    syncHelpAcceptedOrderTracking(["help-ord-1"], ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(true);
    expect(getHelpAcceptedOrderIdsForTests()).toEqual(["help-ord-1"]);
    expect(mockPatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(VENDOR_STOPPED_HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockPatch.mock.calls.length).toBeGreaterThanOrEqual(2);

    syncHelpAcceptedOrderTracking([], ctx);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(false);
  });

  it("does not heartbeat without Go-Live even if Help orders are accepted", async () => {
    syncHelpAcceptedOrderTracking(["help-ord-2"], ctx);
    expect(isHelpStoppedHeartbeatRunningForTests()).toBe(false);
    expect(mockPatch).not.toHaveBeenCalled();
  });
});
