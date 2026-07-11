import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VENDOR_LOCATION_DISTANCE_FILTER_M,
  hasSentIveStarted,
  iveStartedActionStartsTracking,
  isInstantAppointmentOrder,
  isInstantDeliveryOrder,
  isScheduledAppointmentOrder,
  isScheduledDeliveryOrder,
  markIveStartedSent,
  shouldRestoreOrderTracking,
  shouldShowIveStartedButton,
  shouldStartTrackingOnOrderAccept,
  vendorOffersHelp,
} from "@/lib/vendorTrackingPolicy";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
});

describe("vendorTrackingPolicy — 5 cases", () => {
  it("uses distanceFilter 400 within 300–500 band", () => {
    expect(VENDOR_LOCATION_DISTANCE_FILTER_M).toBe(400);
    expect(VENDOR_LOCATION_DISTANCE_FILTER_M).toBeGreaterThanOrEqual(300);
    expect(VENDOR_LOCATION_DISTANCE_FILTER_M).toBeLessThanOrEqual(500);
  });

  it("case 1: Help via service_mode or availability_modes", () => {
    expect(vendorOffersHelp({ service_mode: "help" })).toBe(true);
    expect(vendorOffersHelp({ service_mode: "delivery", availability_modes: ["help"] })).toBe(
      true,
    );
    expect(vendorOffersHelp({ service_mode: "delivery", availability_modes: ["delivery"] })).toBe(
      false,
    );
    expect(vendorOffersHelp({ service_mode: "appointment" })).toBe(false);
  });

  it("case 2: instant appointment starts tracking on accept; scheduled does not", () => {
    const created = "2026-07-11T10:00:00.000Z";
    const instantAppt = new Date(new Date(created).getTime() + 2 * 60 * 60 * 1000).toISOString();
    const instant = {
      id: "a1",
      status: "accepted",
      created_at: created,
      appointment_time: instantAppt,
      appointment_status: "confirmed",
    };
    const scheduled = {
      id: "a2",
      status: "accepted",
      created_at: created,
      appointment_time: "2026-07-20T15:00:00.000Z",
      appointment_status: "confirmed",
    };
    expect(isInstantAppointmentOrder(instant)).toBe(true);
    expect(isScheduledAppointmentOrder(scheduled)).toBe(true);
    expect(shouldStartTrackingOnOrderAccept(instant)).toBe(true);
    expect(shouldStartTrackingOnOrderAccept(scheduled)).toBe(false);
    expect(shouldRestoreOrderTracking(instant)).toBe(true);
    expect(shouldRestoreOrderTracking(scheduled)).toBe(false);
  });

  it("case 3: asap delivery starts tracking; other slots do not", () => {
    const asap = { id: "d1", status: "accepted", delivery_slot: "asap" };
    const tomorrow = { id: "d2", status: "accepted", delivery_slot: "tomorrow" };
    expect(isInstantDeliveryOrder(asap)).toBe(true);
    expect(isScheduledDeliveryOrder(tomorrow)).toBe(true);
    expect(shouldStartTrackingOnOrderAccept(asap)).toBe(true);
    expect(shouldStartTrackingOnOrderAccept(tomorrow)).toBe(false);
  });

  it("cases 4 & 5: I've Started visible for scheduled only; never starts tracking", () => {
    expect(iveStartedActionStartsTracking()).toBe(false);

    const scheduledAppt = {
      id: "a3",
      status: "accepted",
      created_at: "2026-07-11T10:00:00.000Z",
      appointment_time: "2026-07-20T15:00:00.000Z",
      appointment_status: "confirmed",
    };
    const scheduledDelivery = {
      id: "d3",
      status: "accepted",
      delivery_slot: "tomorrow",
    };
    const asap = { id: "d4", status: "accepted", delivery_slot: "asap" };
    const help = { id: "h1", status: "accepted" };

    expect(shouldShowIveStartedButton(scheduledAppt)).toBe(true);
    expect(shouldShowIveStartedButton(scheduledDelivery)).toBe(true);
    expect(shouldShowIveStartedButton(asap)).toBe(false);
    expect(shouldShowIveStartedButton(help)).toBe(false);
    expect(shouldStartTrackingOnOrderAccept(scheduledAppt)).toBe(false);
    expect(shouldStartTrackingOnOrderAccept(scheduledDelivery)).toBe(false);
  });

  it("help accept never starts order-scoped tracking", () => {
    expect(
      shouldStartTrackingOnOrderAccept({ id: "h2", status: "accepted" }),
    ).toBe(false);
  });

  it("ive started storage marks one-time send without implying tracking", () => {
    expect(hasSentIveStarted("o1")).toBe(false);
    markIveStartedSent("o1");
    expect(hasSentIveStarted("o1")).toBe(true);
    expect(iveStartedActionStartsTracking()).toBe(false);
  });
});
