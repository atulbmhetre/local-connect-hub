import { describe, expect, it } from "vitest";
import {
  expandRadarModeMatches,
  radarResultKey,
  stampVendorWithBusiness,
  usableRadarShopPin,
} from "./radarBusinessCards";

describe("expandRadarModeMatches (#1 one card per business)", () => {
  it("renders Mechanic + Nursery as two cards, never cats[0]/primary collapse", () => {
    const cards = expandRadarModeMatches([
      { vendor_id: "v1", category_id: "mechanic" },
      { vendor_id: "v1", category_id: "nursery" },
      { vendor_id: "v2", category_id: "plumber" },
    ]);
    expect(cards).toEqual([
      { vendor_id: "v1", category_id: "mechanic" },
      { vendor_id: "v1", category_id: "nursery" },
      { vendor_id: "v2", category_id: "plumber" },
    ]);
    expect(cards.filter((c) => c.vendor_id === "v1")).toHaveLength(2);
  });

  it("dedupes duplicate match rows", () => {
    expect(
      expandRadarModeMatches([
        { vendor_id: "v1", category_id: "mechanic" },
        { vendor_id: "v1", category_id: "mechanic" },
      ]),
    ).toHaveLength(1);
  });

  it("drops rows missing category_id", () => {
    expect(
      expandRadarModeMatches([{ vendor_id: "v1", category_id: "" }]),
    ).toEqual([]);
  });
});

describe("usableRadarShopPin", () => {
  it("uses the category pin when finite and non-zero", () => {
    expect(usableRadarShopPin(18.5, 73.8)).toEqual({ lat: 18.5, lng: 73.8 });
  });

  it("does not fall back when category GPS is missing", () => {
    expect(usableRadarShopPin(null, 73.8)).toBeNull();
    expect(usableRadarShopPin(18.5, null)).toBeNull();
    expect(usableRadarShopPin(0, 0)).toBeNull();
  });
});

describe("stampVendorWithBusiness (#4/#7 category UPI + shop pin)", () => {
  it("overwrites account UPI/GPS with the matched business row", () => {
    const stamped = stampVendorWithBusiness(
      {
        id: "v1",
        upi_id: "account@upi",
        latitude: 11,
        longitude: 22,
        shop_photo_url: "account.jpg",
      },
      {
        upi_id: "nursery@upi",
        upi_qr_url: "qr.png",
        upi_qr_payee_id: "nursery@upi",
        latitude: 18.1,
        longitude: 73.2,
        shop_photo_url: "nursery.jpg",
      },
    );
    expect(stamped.upi_id).toBe("nursery@upi");
    expect(stamped.latitude).toBe(18.1);
    expect(stamped.longitude).toBe(73.2);
    expect(stamped.shop_photo_url).toBe("nursery.jpg");
    expect(stamped.upi_qr_url).toBe("qr.png");
  });

  it("clears account UPI/GPS when the business row has none — no vendors.* fallback", () => {
    const stamped = stampVendorWithBusiness(
      { id: "v1", upi_id: "account@upi", latitude: 11, longitude: 22 },
      { upi_id: null, latitude: null, longitude: null },
    );
    expect(stamped.upi_id).toBe("");
    expect(stamped.latitude).toBeNull();
    expect(stamped.longitude).toBeNull();
  });
});

describe("radarResultKey", () => {
  it("is unique per business", () => {
    expect(radarResultKey("v1", "a")).not.toBe(radarResultKey("v1", "b"));
  });
});
