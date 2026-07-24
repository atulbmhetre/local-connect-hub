import type { VerificationDisplayTier } from "@/components/VerificationBadge";

/** Signals used by Radar's strict binary vendor-trust gate (no yellow/pending). */
export type VendorBinaryTrustSignals = {
  is_manual_verified?: boolean | null;
  upi_verified?: boolean | null;
  photo_selfie?: string | null;
  latitude?: number | null;
};

/**
 * Radar / AiBridge / Parchi order-path banner tier.
 * Green only when manual verify + UPI verified + selfie + GPS are all present;
 * otherwise red. Never yellow — standing "no partial trust state" decision.
 */
export function vendorBinaryTrustTier(
  v: VendorBinaryTrustSignals,
): Extract<VerificationDisplayTier, "green" | "red"> {
  if (
    v.is_manual_verified === true &&
    v.upi_verified === true &&
    !!v.photo_selfie &&
    v.latitude != null
  ) {
    return "green";
  }
  return "red";
}
