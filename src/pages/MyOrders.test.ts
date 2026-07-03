import { describe, expect, it } from "vitest";
import { wasOrderEngaged } from "@/pages/MyOrders";

const REQUEST_STATUSES = [
  "sent",
  "seen",
  "accepted",
  "fulfilled",
  "done",
  "cancelled",
  "expired",
] as const;

const NON_CONFIRMED_APPOINTMENT = null;
const CONFIRMED_APPOINTMENT = "confirmed";

function expectedWasOrderEngaged(
  status: (typeof REQUEST_STATUSES)[number],
  appointmentStatus: string | null,
): boolean {
  return (
    status === "accepted" ||
    status === "fulfilled" ||
    appointmentStatus === "confirmed"
  );
}

describe("wasOrderEngaged", () => {
  it.each(
    REQUEST_STATUSES.flatMap((status) => [
      [status, NON_CONFIRMED_APPOINTMENT, expectedWasOrderEngaged(status, NON_CONFIRMED_APPOINTMENT)],
      [status, CONFIRMED_APPOINTMENT, expectedWasOrderEngaged(status, CONFIRMED_APPOINTMENT)],
    ] as const),
  )(
    "status=%s appointment_status=%s → %s",
    (status, appointment_status, expected) => {
      expect(wasOrderEngaged({ status, appointment_status })).toBe(expected);
    },
  );

  it("is false for sent/seen/cancelled/expired/done when appointment is not confirmed", () => {
    for (const status of ["sent", "seen", "cancelled", "expired", "done"] as const) {
      expect(wasOrderEngaged({ status, appointment_status: null })).toBe(false);
      expect(wasOrderEngaged({ status, appointment_status: "pending" })).toBe(false);
    }
  });

  it("is true for accepted and fulfilled regardless of appointment_status", () => {
    for (const appointment_status of [null, "pending", CONFIRMED_APPOINTMENT]) {
      expect(wasOrderEngaged({ status: "accepted", appointment_status })).toBe(true);
      expect(wasOrderEngaged({ status: "fulfilled", appointment_status })).toBe(true);
    }
  });

  it("is true when appointment_status is confirmed regardless of request status", () => {
    for (const status of REQUEST_STATUSES) {
      expect(wasOrderEngaged({ status, appointment_status: CONFIRMED_APPOINTMENT })).toBe(true);
    }
  });
});
