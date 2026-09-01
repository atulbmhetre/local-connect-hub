import { describe, expect, it } from "vitest";
import {
  computeTrustLevelForBusiness,
  deriveBusinessLocationPasses,
  statusForBusinessCheck,
  type BusinessLocationRow,
  type VendorVerificationRow,
} from "./trustLevel";

const vendorId = "v1";
const cobblerId = "cat-cobbler";
const carpenterId = "cat-carpenter";

const accountBronze: VendorVerificationRow[] = [
  { vendor_id: vendorId, check_type: "upi_format", status: "passed", is_latest: true },
  { vendor_id: vendorId, check_type: "photo_selfie", status: "passed", is_latest: true },
  { vendor_id: vendorId, check_type: "admin_check", status: "dormant", is_latest: true },
  // Stale account-level location rows must be ignored:
  { vendor_id: vendorId, check_type: "photo_shop", status: "passed", is_latest: true },
  { vendor_id: vendorId, check_type: "gps", status: "passed", is_latest: true },
];

const cobbler: BusinessLocationRow = {
  vendor_id: vendorId,
  category_id: cobblerId,
  shop_photo_url: "https://example.test/cobbler.jpg",
  gps_match_distance: 10,
  location_accuracy: 5,
  photo_accuracy: 5,
  verification_status: "business_verified",
};

const carpenter: BusinessLocationRow = {
  vendor_id: vendorId,
  category_id: carpenterId,
  shop_photo_url: null,
  gps_match_distance: null,
  verification_status: null,
};

describe("deriveBusinessLocationPasses", () => {
  it("passes photo_shop and gps for in-tolerance non-soft-fail row", () => {
    expect(deriveBusinessLocationPasses(cobbler)).toEqual({ photo_shop: true, gps: true });
  });

  it("fails both when soft-fail even with photo+gps", () => {
    expect(
      deriveBusinessLocationPasses({
        ...cobbler,
        verification_status: "pending_location_review",
      }),
    ).toEqual({ photo_shop: false, gps: false });
  });
});

describe("computeTrustLevelForBusiness", () => {
  it("Cobbler with photo+gps is Bronze; Carpenter without photo is Unverified", () => {
    const businesses = [cobbler, carpenter];
    expect(
      computeTrustLevelForBusiness(vendorId, cobblerId, accountBronze, businesses),
    ).toBe("Bronze");
    expect(
      computeTrustLevelForBusiness(vendorId, carpenterId, accountBronze, businesses),
    ).toBe("Unverified");
  });

  it("ignores account VV photo_shop/gps when business lacks proof", () => {
    expect(
      computeTrustLevelForBusiness(vendorId, carpenterId, accountBronze, [carpenter]),
    ).toBe("Unverified");
  });

  it("colocated businesses with same proof share Bronze", () => {
    const twin: BusinessLocationRow = { ...cobbler, category_id: carpenterId };
    expect(
      computeTrustLevelForBusiness(vendorId, cobblerId, accountBronze, [cobbler, twin]),
    ).toBe("Bronze");
    expect(
      computeTrustLevelForBusiness(vendorId, carpenterId, accountBronze, [cobbler, twin]),
    ).toBe("Bronze");
  });
});

describe("statusForBusinessCheck", () => {
  it("reports different photo_shop status per business", () => {
    const businesses = [cobbler, carpenter];
    expect(
      statusForBusinessCheck("photo_shop", vendorId, cobblerId, accountBronze, businesses),
    ).toBe("passed");
    expect(
      statusForBusinessCheck("photo_shop", vendorId, carpenterId, accountBronze, businesses),
    ).toBe("pending");
    expect(
      statusForBusinessCheck("upi_format", vendorId, carpenterId, accountBronze, businesses),
    ).toBe("passed");
  });

  it("shows coming_soon for dormant aadhaar_digilocker, not a live flow", () => {
    const rows: VendorVerificationRow[] = [
      ...accountBronze,
      { vendor_id: vendorId, check_type: "aadhaar_digilocker", status: "dormant", is_latest: true },
    ];
    expect(
      statusForBusinessCheck("aadhaar_digilocker", vendorId, cobblerId, rows, [cobbler]),
    ).toBe("coming_soon");
  });
});
