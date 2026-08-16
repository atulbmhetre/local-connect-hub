import { describe, expect, it } from "vitest";
import { shouldScheduleForegroundLocal } from "@/lib/pushNotifications";

describe("shouldScheduleForegroundLocal", () => {
  it("skips local schedule when FCM notification payload already has title (Cap alert path)", () => {
    expect(
      shouldScheduleForegroundLocal({
        title: "Order accepted",
        body: "Your vendor accepted the order",
        data: { type: "order_accepted", order_id: "req-1" },
      }),
    ).toBe(false);
  });

  it("skips local schedule when only body is set on the notification payload", () => {
    expect(
      shouldScheduleForegroundLocal({
        title: undefined,
        body: "Bill ready",
        data: { type: "bill" },
      }),
    ).toBe(false);
  });

  it("schedules local for data-only pushes that carry display copy", () => {
    expect(
      shouldScheduleForegroundLocal({
        title: undefined,
        body: undefined,
        data: { title: "Silent path title", body: "Silent path body", type: "order_update" },
      }),
    ).toBe(true);
  });

  it("does not schedule for silent data-only pings with no display copy", () => {
    expect(
      shouldScheduleForegroundLocal({
        title: undefined,
        body: undefined,
        data: { type: "location_ping", order_id: "req-1" },
      }),
    ).toBe(false);
  });

  it("treats whitespace-only notification title/body as absent", () => {
    expect(
      shouldScheduleForegroundLocal({
        title: "   ",
        body: "  ",
        data: { title: "From data", body: "Copy" },
      }),
    ).toBe(true);
  });
});
