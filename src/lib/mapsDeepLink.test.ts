import { describe, expect, it } from "vitest";
import {
  buildAddressMapsUrl,
  buildCoordsMapsUrl,
  isOrderJobActiveForMaps,
  resolveCustomerMapsUrl,
  resolveCustomerNavigateToVendorUrl,
  resolveVendorNavigateToCustomerUrl,
  type CustomerMapsFields,
} from "@/lib/mapsDeepLink";

const COME_TO_ME = "[Come to my place]";
const VISIT_SHOP = "[I'll visit your shop]";

function row(overrides: Partial<CustomerMapsFields> = {}): CustomerMapsFields {
  return {
    status: "sent",
    ...overrides,
  };
}

describe("buildCoordsMapsUrl / buildAddressMapsUrl / resolveCustomerMapsUrl", () => {
  it("MAPS-UNIT-01: coords provided → returns q=lat,lng with correct precision", () => {
    const lat = 18.50743;
    const lng = 73.80774;
    expect(buildCoordsMapsUrl(lat, lng)).toBe("https://www.google.com/maps?q=18.50743,73.80774");
    expect(resolveCustomerMapsUrl(row({ customer_latitude: lat, customer_longitude: lng }))).toBe(
      "https://www.google.com/maps?q=18.50743,73.80774",
    );
  });

  it("MAPS-UNIT-02: address only → returns search URL with encoded query", () => {
    const address = "Flat 12, MG Road & Co";
    const url = resolveCustomerMapsUrl(row({ delivery_address: address }));
    expect(url).toBe(buildAddressMapsUrl(address));
    expect(url).toBe(
      "https://www.google.com/maps/search/?api=1&query=Flat%2012%2C%20MG%20Road%20%26%20Co",
    );
  });

  it("MAPS-UNIT-03: both coords and address → coords take priority", () => {
    const url = resolveCustomerMapsUrl(
      row({
        customer_latitude: 18.52,
        customer_longitude: 73.85,
        delivery_address: "Some address",
      }),
    );
    expect(url).toBe("https://www.google.com/maps?q=18.52,73.85");
  });

  it("MAPS-UNIT-04: null coords + null address → returns null", () => {
    expect(
      resolveCustomerMapsUrl(
        row({
          customer_latitude: null,
          customer_longitude: null,
          delivery_address: null,
        }),
      ),
    ).toBeNull();
  });

  it("MAPS-UNIT-05: coords 0,0 → treated as valid coords", () => {
    expect(resolveCustomerMapsUrl(row({ customer_latitude: 0, customer_longitude: 0 }))).toBe(
      "https://www.google.com/maps?q=0,0",
    );
  });

  it("MAPS-UNIT-06: Hindi/Marathi address → correctly URL-encoded", () => {
    const address = "पुणे, महाराष्ट्र";
    expect(buildAddressMapsUrl(address)).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
    );
  });

  it("MAPS-UNIT-07: address with &, +, # → correctly encoded", () => {
    const address = "A & B + C #123";
    expect(buildAddressMapsUrl(address)).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
    );
  });
});

describe("resolveVendorNavigateToCustomerUrl / resolveCustomerNavigateToVendorUrl", () => {
  it("MAPS-UNIT-08: delivery mode, vendor navigates to customer location", () => {
    const url = resolveVendorNavigateToCustomerUrl("delivery", row({
      customer_latitude: 18.1,
      customer_longitude: 73.2,
    }));
    expect(url).toBe("https://www.google.com/maps?q=18.1,73.2");
  });

  it("MAPS-UNIT-09: help mode, vendor navigates to customer location", () => {
    const url = resolveVendorNavigateToCustomerUrl("help", row({
      customer_latitude: 19.0,
      customer_longitude: 72.5,
    }));
    expect(url).toBe("https://www.google.com/maps?q=19,72.5");
  });

  it("MAPS-UNIT-10: booking come to me, vendor navigates to customer location", () => {
    const url = resolveVendorNavigateToCustomerUrl("appointment", row({
      message: `${COME_TO_ME} Haircut`,
      customer_latitude: 18.50743,
      customer_longitude: 73.80774,
    }));
    expect(url).toBe("https://www.google.com/maps?q=18.50743,73.80774");
  });

  it("MAPS-UNIT-11: booking I'll come to you, customer navigates to vendor shop", () => {
    const url = resolveCustomerNavigateToVendorUrl({
      status: "sent",
      message: `${VISIT_SHOP} Haircut`,
      vendors: {
        service_mode: "appointment",
        latitude: 18.5204,
        longitude: 73.8567,
      },
    });
    expect(url).toBe("https://www.google.com/maps?q=18.5204,73.8567");
  });

  it("MAPS-UNIT-12: booking I'll come to you, vendor side → no map", () => {
    const url = resolveVendorNavigateToCustomerUrl("appointment", row({
      message: `${VISIT_SHOP} Haircut`,
      customer_latitude: 18.50743,
      customer_longitude: 73.80774,
    }));
    expect(url).toBeNull();
  });
});

describe("isOrderJobActiveForMaps", () => {
  it("MAPS-UNIT-13: status active → should show button", () => {
    expect(isOrderJobActiveForMaps("active")).toBe(true);
  });

  it("MAPS-UNIT-14: status accepted → should show button", () => {
    expect(isOrderJobActiveForMaps("accepted")).toBe(true);
  });

  it("MAPS-UNIT-15: status fulfilled → should NOT show button", () => {
    expect(isOrderJobActiveForMaps("fulfilled")).toBe(false);
  });

  it("MAPS-UNIT-16: status completed → should NOT show button", () => {
    expect(isOrderJobActiveForMaps("completed")).toBe(false);
  });

  it("MAPS-UNIT-17: status cancelled → should NOT show button", () => {
    expect(isOrderJobActiveForMaps("cancelled")).toBe(false);
  });

  it("MAPS-UNIT-18: status confirmed → should NOT show button", () => {
    expect(isOrderJobActiveForMaps("confirmed")).toBe(false);
  });

  it("MAPS-UNIT-19: status done → should NOT show button", () => {
    expect(isOrderJobActiveForMaps("done")).toBe(false);
  });
});
