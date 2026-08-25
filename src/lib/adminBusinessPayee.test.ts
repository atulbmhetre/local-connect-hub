import { describe, expect, it } from "vitest";
import { resolveAdminBusinessPayeeAndPin } from "./adminBusinessPayee";

describe("resolveAdminBusinessPayeeAndPin (#6)", () => {
  it("uses the picked business GPS + UPI only", () => {
    expect(
      resolveAdminBusinessPayeeAndPin({
        category_id: "nursery",
        latitude: 18.1,
        longitude: 73.2,
        upi_id: "shop@upi",
        shop_photo_url: "shop.jpg",
        gps_match_distance: 12,
      }),
    ).toEqual({
      hasBusiness: true,
      latitude: 18.1,
      longitude: 73.2,
      upiId: "shop@upi",
      shopPhotoUrl: "shop.jpg",
      gpsMatchDistance: 12,
    });
  });

  it("empty business fields stay empty — does not accept account fallback args", () => {
    expect(
      resolveAdminBusinessPayeeAndPin({
        category_id: "nursery",
        latitude: null,
        longitude: null,
        upi_id: "  ",
        shop_photo_url: null,
        gps_match_distance: null,
      }),
    ).toEqual({
      hasBusiness: true,
      latitude: null,
      longitude: null,
      upiId: null,
      shopPhotoUrl: null,
      gpsMatchDistance: null,
    });
  });

  it("no vendor_categories row → not verifiable", () => {
    expect(resolveAdminBusinessPayeeAndPin(null)).toEqual({
      hasBusiness: false,
      latitude: null,
      longitude: null,
      upiId: null,
      shopPhotoUrl: null,
      gpsMatchDistance: null,
    });
    expect(resolveAdminBusinessPayeeAndPin({ category_id: null, upi_id: "account@upi", latitude: 1, longitude: 2 })).toEqual({
      hasBusiness: false,
      latitude: null,
      longitude: null,
      upiId: null,
      shopPhotoUrl: null,
      gpsMatchDistance: null,
    });
  });
});
