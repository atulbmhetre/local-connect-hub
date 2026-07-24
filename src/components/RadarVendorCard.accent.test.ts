import { describe, expect, it } from "vitest";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";

/** Mirrors RadarVendorCard accentRing mapping — must stay identical to banner gate. */
function accentRingClass(signals: Parameters<typeof vendorBinaryTrustTier>[0]): string {
  return vendorBinaryTrustTier(signals) === "green"
    ? "ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
    : "ring-destructive/30";
}

describe("RadarVendorCard accent ring ↔ vendorBinaryTrustTier", () => {
  const complete = {
    is_manual_verified: true,
    upi_verified: true,
    photo_selfie: "https://example.com/s.jpg",
    latitude: 18.5,
  };

  it("green tier yields brand accent; any missing signal yields destructive", () => {
    expect(accentRingClass(complete)).toContain("ring-brand");
    expect(accentRingClass({ ...complete, is_manual_verified: false })).toContain(
      "ring-destructive",
    );
    expect(accentRingClass({ ...complete, photo_selfie: null })).toContain("ring-destructive");
    // Same four-signal contract as the old inline check (photo_selfie != null).
    expect(vendorBinaryTrustTier({ ...complete, photo_selfie: "" })).toBe("red");
  });
});
