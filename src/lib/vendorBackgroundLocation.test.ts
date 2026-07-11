import { beforeEach, describe, expect, it, vi } from "vitest";

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
  startHelpLiveTracking,
  startOrderTracking,
  stopAllVendorLocationTracking,
  stopHelpLiveTracking,
  stopOrderTracking,
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
