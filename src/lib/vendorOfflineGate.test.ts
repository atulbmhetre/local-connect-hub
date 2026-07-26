import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_OFFLINE_WARN_WITHIN_MS,
  appointmentWarnsGoingOffline,
  isAppointmentToday,
} from "./vendorOfflineGate";

describe("appointmentWarnsGoingOffline", () => {
  it("warns for same calendar day even if hours away", () => {
    const now = new Date("2026-07-25T10:00:00+05:30");
    const laterToday = new Date("2026-07-25T22:00:00+05:30").toISOString();
    expect(isAppointmentToday(laterToday, now)).toBe(true);
    expect(appointmentWarnsGoingOffline(laterToday, now)).toBe(true);
  });

  it("warns for appointment 2h ahead that crosses local midnight", () => {
    const now = new Date("2026-07-25T23:00:00+05:30");
    const afterMidnight = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    expect(isAppointmentToday(afterMidnight, now)).toBe(false);
    expect(appointmentWarnsGoingOffline(afterMidnight, now)).toBe(true);
  });

  it("does not warn for tomorrow well beyond the near-term window", () => {
    const now = new Date("2026-07-25T22:00:00+05:30");
    const farTomorrow = new Date("2026-07-26T20:00:00+05:30");
    expect(isAppointmentToday(farTomorrow.toISOString(), now)).toBe(false);
    expect(farTomorrow.getTime() - now.getTime()).toBeGreaterThan(APPOINTMENT_OFFLINE_WARN_WITHIN_MS);
    expect(appointmentWarnsGoingOffline(farTomorrow.toISOString(), now)).toBe(false);
  });

  it("does not warn for invalid timestamps", () => {
    expect(appointmentWarnsGoingOffline("not-a-date")).toBe(false);
  });
});
