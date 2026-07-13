import { describe, expect, it } from "vitest";
import {
  accountTrustReady,
  businessBadgeTone,
  isBusinessFullyVerified,
} from "./businessTrust";

const readyAccount = {
  phone: "9876543210",
  upi_verified: true,
  photo_selfie: "https://example.com/selfie.jpg",
  latitude: 18.5,
  longitude: 73.8,
};

describe("accountTrustReady", () => {
  it("requires phone, upi, selfie, and gps", () => {
    expect(accountTrustReady(readyAccount)).toBe(true);
    expect(accountTrustReady({ ...readyAccount, upi_verified: false })).toBe(false);
    expect(accountTrustReady({ ...readyAccount, photo_selfie: null })).toBe(false);
    expect(accountTrustReady({ ...readyAccount, latitude: null })).toBe(false);
  });
});

describe("isBusinessFullyVerified", () => {
  it("is verified only with account ready + category is_manual_verified", () => {
    expect(
      isBusinessFullyVerified(readyAccount, { is_manual_verified: true }),
    ).toBe(true);
    expect(
      isBusinessFullyVerified(readyAccount, { is_manual_verified: false }),
    ).toBe(false);
    expect(
      isBusinessFullyVerified(readyAccount, {
        is_manual_verified: false,
        shop_photo_url: "https://x",
        verification_status: "business_verified",
      }),
    ).toBe(false);
    expect(
      isBusinessFullyVerified(
        { ...readyAccount, upi_verified: false },
        { is_manual_verified: true },
      ),
    ).toBe(false);
  });

  it("exposes binary badge tones only", () => {
    expect(businessBadgeTone(readyAccount, { is_manual_verified: true })).toBe(
      "verified",
    );
    expect(businessBadgeTone(readyAccount, { is_manual_verified: false })).toBe(
      "unverified",
    );
  });
});
