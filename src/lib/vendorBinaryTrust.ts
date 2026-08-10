import type { VerificationDisplayTier } from "@/components/VerificationBadge";

/** Signals used by Radar's strict binary vendor-trust gate (no yellow/pending). */
export type VendorBinaryTrustSignals = {
  is_manual_verified?: boolean | null;
  upi_verified?: boolean | null;
  photo_selfie?: string | null;
  /** @deprecated Use businessGpsVerified instead for per-business GPS checks */
  latitude?: number | null;
  /** Per-business GPS verification status (derived from business location proof) */
  businessGpsVerified?: boolean;
};

/**
 * Radar / AiBridge / Parchi order-path banner tier.
 * Green only when manual verify + UPI verified + selfie + GPS are all present;
 * otherwise red. Never yellow — standing "no partial trust state" decision.
 */
export function vendorBinaryTrustTier(
  v: VendorBinaryTrustSignals,
): Extract<VerificationDisplayTier, "green" | "red"> {
  // Use per-business GPS verification if available, fall back to account-level for backward compatibility
  const gpsVerified = v.businessGpsVerified ?? (v.latitude != null);
  
  if (
    v.is_manual_verified === true &&
    v.upi_verified === true &&
    !!v.photo_selfie &&
    gpsVerified
  ) {
    return "green";
  }
  return "red";
}
