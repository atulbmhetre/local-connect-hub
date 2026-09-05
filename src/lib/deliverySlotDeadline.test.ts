import { describe, expect, it } from "vitest";
import {
  APP_TIME_ZONE,
  DELIVERY_ASAP_OFFSET_MS,
  DELIVERY_SLOT_CUTOFF_HOUR,
  DELIVERY_SLOT_DEADLINE_HOUR,
  getDeliverySlotDeadline,
  getDeliverySlotWindowStart,
  getIstHour,
  getIstYmd,
  INSTANT_ORDER_DETECT_TOLERANCE_MS,
  zonedIstDateTimeToUtcIso,
} from "@/lib/deliverySlotDeadline";

describe("zonedIstDateTimeToUtcIso / SQL AT TIME ZONE Asia/Kolkata", () => {
  it("maps noon IST to 06:30 UTC", () => {
    expect(zonedIstDateTimeToUtcIso(2026, 3, 15, 12)).toBe("2026-03-15T06:30:00.000Z");
  });

  it("maps 20:00 IST to 14:30 UTC", () => {
    expect(zonedIstDateTimeToUtcIso(2026, 3, 16, 20)).toBe("2026-03-16T14:30:00.000Z");
  });
});

describe("getDeliverySlotDeadline — IST, not device-local", () => {
  it("morning / afternoon / evening match Kolkata wall times (same as IST device)", () => {
    // 08:00 UTC = 13:30 IST on 15 Mar 2026
    const now = new Date("2026-03-15T08:00:00.000Z");
    expect(getDeliverySlotDeadline("morning", now)).toBe("2026-03-15T06:30:00.000Z"); // 12:00 IST
    expect(getDeliverySlotDeadline("afternoon", now)).toBe("2026-03-15T10:30:00.000Z"); // 16:00 IST
    expect(getDeliverySlotDeadline("evening", now)).toBe("2026-03-15T14:30:00.000Z"); // 20:00 IST
  });

  it("asap is +2h from the real instant (timezone-independent)", () => {
    const now = new Date("2026-03-15T08:00:00.000Z");
    expect(getDeliverySlotDeadline("asap", now)).toBe("2026-03-15T10:00:00.000Z");
  });

  it("tomorrow is next IST calendar day at 20:00 IST", () => {
    const now = new Date("2026-03-15T08:00:00.000Z");
    expect(getDeliverySlotDeadline("tomorrow", now)).toBe("2026-03-16T14:30:00.000Z");
  });

  /**
   * Proof the old Date#setHours bug is gone: at this instant it is still 15 Jun
   * in UTC / US Pacific evening, but already 16 Jun 00:00 in IST.
   * Device-local setHours(12) on a UTC machine would stamp 15 Jun 12:00 UTC.
   * IST-correct morning is 16 Jun 12:00 IST = 16 Jun 06:30 UTC.
   */
  it("uses IST calendar day across the UTC/IST date line (UTC/Pacific device case)", () => {
    const now = new Date("2026-06-15T18:30:00.000Z"); // midnight IST 16 Jun
    expect(APP_TIME_ZONE).toBe("Asia/Kolkata");
    expect(getIstYmd(now)).toEqual({ year: 2026, month: 6, day: 16 });

    const istCorrect = getDeliverySlotDeadline("morning", now);
    expect(istCorrect).toBe("2026-06-16T06:30:00.000Z");

    // Simulate legacy UTC-device local noon (what setHours(12) did in UTC):
    const legacyUtcDevice = new Date(now);
    legacyUtcDevice.setUTCHours(12, 0, 0, 0);
    expect(legacyUtcDevice.toISOString()).toBe("2026-06-15T12:00:00.000Z");
    expect(istCorrect).not.toBe(legacyUtcDevice.toISOString());

    // Simulate legacy US Pacific device (PDT, UTC-7): local noon = 19:00 UTC same calendar day.
    const legacyPacificLocalNoon = "2026-06-15T19:00:00.000Z";
    expect(istCorrect).not.toBe(legacyPacificLocalNoon);
  });

  it("produces the same stored deadline a Kolkata device would for the same instant", () => {
    // Same real-world moment; only the "device TZ" narrative changes — helper ignores it.
    const now = new Date("2026-01-10T02:15:00.000Z"); // 07:45 IST
    const fromUtcNarrative = getDeliverySlotDeadline("evening", now);
    const fromPacificNarrative = getDeliverySlotDeadline("evening", new Date(now.getTime()));
    expect(fromUtcNarrative).toBe(fromPacificNarrative);
    expect(fromUtcNarrative).toBe("2026-01-10T14:30:00.000Z"); // 20:00 IST
  });
});

describe("getDeliverySlotWindowStart — SQL mirror on IST deadlines", () => {
  it("morning window opens at 08:00 IST when deadline is noon IST", () => {
    const deadline = getDeliverySlotDeadline(
      "morning",
      new Date("2026-03-15T03:00:00.000Z"),
    );
    const start = getDeliverySlotWindowStart("morning", deadline);
    expect(deadline).toBe("2026-03-15T06:30:00.000Z");
    expect(start?.toISOString()).toBe("2026-03-15T02:30:00.000Z"); // 08:00 IST
  });

  it("tomorrow window opens at midnight IST of the deadline day", () => {
    const deadline = getDeliverySlotDeadline(
      "tomorrow",
      new Date("2026-03-15T08:00:00.000Z"),
    );
    const start = getDeliverySlotWindowStart("tomorrow", deadline);
    expect(deadline).toBe("2026-03-16T14:30:00.000Z"); // 20:00 IST 16th
    // 14:30Z − 20h = 18:30Z previous calendar day UTC = midnight IST on the 16th
    expect(start?.toISOString()).toBe("2026-03-15T18:30:00.000Z");
  });

  it("returns null for asap", () => {
    expect(getDeliverySlotWindowStart("asap", new Date().toISOString())).toBeNull();
  });
});

describe("getIstHour", () => {
  it("reads Kolkata hour, not UTC", () => {
    // 06:00 UTC = 11:30 IST
    expect(getIstHour(new Date("2026-03-15T06:00:00.000Z"))).toBe(11);
  });
});

describe("shared slot / ASAP constants", () => {
  it("keeps UI cutoffs one hour before IST deadline hours", () => {
    expect(DELIVERY_SLOT_CUTOFF_HOUR.morning).toBe(DELIVERY_SLOT_DEADLINE_HOUR.morning - 1);
    expect(DELIVERY_SLOT_CUTOFF_HOUR.afternoon).toBe(DELIVERY_SLOT_DEADLINE_HOUR.afternoon - 1);
    expect(DELIVERY_SLOT_CUTOFF_HOUR.evening).toBe(DELIVERY_SLOT_DEADLINE_HOUR.evening - 1);
  });

  it("exports ASAP 2h and instant detect 15m for tracking policy pairing", () => {
    expect(DELIVERY_ASAP_OFFSET_MS).toBe(2 * 60 * 60 * 1000);
    expect(INSTANT_ORDER_DETECT_TOLERANCE_MS).toBe(15 * 60 * 1000);
  });
});
