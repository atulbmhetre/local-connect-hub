import { describe, expect, it } from "vitest";
import {
  canCancelAcceptedOrder,
  canShowCustomerCancelOrder,
  canShowPreAcceptCancel,
  getDeliverySlotWindowStart,
  shouldShowDismissInsteadOfCancel,
} from "@/lib/customerCancelPolicy";
import { getDeliverySlotDeadline } from "@/lib/deliverySlotDeadline";

describe("getDeliverySlotWindowStart", () => {
  it("returns null for asap", () => {
    expect(getDeliverySlotWindowStart("asap", new Date().toISOString())).toBeNull();
  });

  it("returns deadline − 4h for morning (IST noon → 08:00 IST)", () => {
    const deadline = getDeliverySlotDeadline(
      "morning",
      new Date("2026-08-16T03:00:00.000Z"),
    );
    const start = getDeliverySlotWindowStart("morning", deadline);
    expect(deadline).toBe("2026-08-16T06:30:00.000Z");
    expect(start?.toISOString()).toBe("2026-08-16T02:30:00.000Z");
  });

  it("returns deadline − 20h for tomorrow (IST 20:00 → midnight IST)", () => {
    const deadline = getDeliverySlotDeadline(
      "tomorrow",
      new Date("2026-08-16T08:00:00.000Z"),
    );
    const start = getDeliverySlotWindowStart("tomorrow", deadline);
    expect(deadline).toBe("2026-08-17T14:30:00.000Z");
    expect(start?.toISOString()).toBe("2026-08-16T18:30:00.000Z");
  });
});

describe("canShowPreAcceptCancel", () => {
  it("allows sent", () => {
    expect(canShowPreAcceptCancel({ status: "sent", created_at: new Date().toISOString() })).toBe(
      true,
    );
  });

  it("blocks seen within 24h", () => {
    expect(
      canShowPreAcceptCancel({
        status: "seen",
        created_at: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  it("allows seen after 24h", () => {
    const created = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    expect(canShowPreAcceptCancel({ status: "seen", created_at: created })).toBe(true);
  });
});

describe("canCancelAcceptedOrder", () => {
  it("allows help accepted before vendor started", () => {
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "help",
        vendor_started_at: null,
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks help after vendor started", () => {
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "help",
        vendor_started_at: new Date().toISOString(),
      }).allowed,
    ).toBe(false);
  });

  it("blocks delivery asap when accepted", () => {
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "delivery",
        delivery_slot: "asap",
        delivery_slot_deadline: new Date(Date.now() + 2 * 3600e3).toISOString(),
      }),
    ).toEqual({ allowed: false, reason: "asap_accepted" });
  });

  it("allows delivery morning before window start", () => {
    const deadline = new Date(Date.now() + 6 * 3600e3);
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "delivery",
        delivery_slot: "morning",
        delivery_slot_deadline: deadline.toISOString(),
      }),
    ).toEqual({ allowed: true });
  });

  it("blocks delivery after window start", () => {
    const deadline = new Date(Date.now() - 1 * 3600e3);
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "delivery",
        delivery_slot: "evening",
        delivery_slot_deadline: deadline.toISOString(),
      }).allowed,
    ).toBe(false);
  });

  it("never allows appointment via this path", () => {
    expect(
      canCancelAcceptedOrder({
        status: "accepted",
        service_mode: "appointment",
        appointment_time: new Date().toISOString(),
      }),
    ).toEqual({ allowed: false, reason: "appointment_use_dismiss" });
  });
});

describe("canShowCustomerCancelOrder / dismiss vs cancel", () => {
  it("shows cancel for accepted help not started", () => {
    expect(
      canShowCustomerCancelOrder({
        status: "accepted",
        service_mode: "help",
        vendor_started_at: null,
      }),
    ).toBe(true);
  });

  it("prefers cancel over dismiss when cancel still valid", () => {
    expect(
      shouldShowDismissInsteadOfCancel(
        {
          status: "accepted",
          service_mode: "help",
          vendor_started_at: null,
        },
        { hasUnpaidBill: true },
      ),
    ).toBe(false);
  });

  it("when cancel invalid, dismiss surface is preferred (unpaid bill blocks separately)", () => {
    expect(
      shouldShowDismissInsteadOfCancel(
        {
          status: "accepted",
          service_mode: "delivery",
          delivery_slot: "asap",
          delivery_slot_deadline: new Date().toISOString(),
        },
        { hasUnpaidBill: true },
      ),
    ).toBe(true);
  });
});
