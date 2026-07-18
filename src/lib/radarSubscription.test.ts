import { describe, expect, it } from "vitest";
import { isVendorSubscriptionVisibleOnRadar } from "./radarSubscription";

describe("isVendorSubscriptionVisibleOnRadar", () => {
  it("allows trial and active", () => {
    expect(isVendorSubscriptionVisibleOnRadar({ subscription_status: "trial" })).toBe(true);
    expect(isVendorSubscriptionVisibleOnRadar({ subscription_status: "active" })).toBe(true);
    expect(isVendorSubscriptionVisibleOnRadar({})).toBe(true);
  });

  it("allows grace while grace_ends_at is in the future", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      isVendorSubscriptionVisibleOnRadar({ subscription_status: "grace", grace_ends_at: future }),
    ).toBe(true);
  });

  it("blocks grace after grace_ends_at", () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      isVendorSubscriptionVisibleOnRadar({ subscription_status: "grace", grace_ends_at: past }),
    ).toBe(false);
  });

  it("blocks expired and cancelled", () => {
    expect(isVendorSubscriptionVisibleOnRadar({ subscription_status: "expired" })).toBe(false);
    expect(isVendorSubscriptionVisibleOnRadar({ subscription_status: "cancelled" })).toBe(false);
  });
});
