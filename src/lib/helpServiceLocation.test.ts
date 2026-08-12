import { describe, expect, it } from "vitest";
import { resolveHelpServiceLocation } from "@/lib/helpServiceLocation";

describe("resolveHelpServiceLocation", () => {
  it("maps home to customer_place and shop to vendor_place", () => {
    expect(
      resolveHelpServiceLocation("home", {
        canServeAtCustomer: true,
        canServeAtVendor: true,
      }),
    ).toBe("customer_place");
    expect(
      resolveHelpServiceLocation("shop", {
        canServeAtCustomer: true,
        canServeAtVendor: true,
      }),
    ).toBe("vendor_place");
  });

  it("infers single-reach vendors when UI choice is unset", () => {
    expect(
      resolveHelpServiceLocation(null, {
        canServeAtCustomer: true,
        canServeAtVendor: false,
      }),
    ).toBe("customer_place");
    expect(
      resolveHelpServiceLocation(null, {
        canServeAtCustomer: false,
        canServeAtVendor: true,
      }),
    ).toBe("vendor_place");
  });

  it("returns null when both reach options exist but user has not chosen", () => {
    expect(
      resolveHelpServiceLocation(null, {
        canServeAtCustomer: true,
        canServeAtVendor: true,
      }),
    ).toBeNull();
  });
});
