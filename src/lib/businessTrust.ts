/** Per-business trust: binary Verified vs Unverified for customer-facing UI. */

export type AccountTrustSignals = {
  phone?: string | null;
  upi_verified?: boolean | null;
  photo_selfie?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

export type BusinessTrustSignals = {
  is_manual_verified?: boolean | null;
  shop_photo_url?: string | null;
  verification_status?: string | null;
};

/** Account-level prerequisites for any business to show Verified. */
export function accountTrustReady(account: AccountTrustSignals): boolean {
  const phoneOk = String(account.phone ?? "").replace(/\D/g, "").length >= 10;
  const upiOk = account.upi_verified === true;
  const selfieOk =
    account.photo_selfie != null && String(account.photo_selfie).trim() !== "";
  const gpsOk = account.latitude != null && account.longitude != null;
  return phoneOk && upiOk && selfieOk && gpsOk;
}

/**
 * Customer-facing badge: Verified only when account checks pass AND this
 * business is admin-approved. No intermediate / pending state.
 */
export function isBusinessFullyVerified(
  account: AccountTrustSignals,
  business: BusinessTrustSignals | null | undefined,
): boolean {
  if (!business) return false;
  return accountTrustReady(account) && business.is_manual_verified === true;
}

export type BusinessBadgeTone = "verified" | "unverified";

export function businessBadgeTone(
  account: AccountTrustSignals,
  business: BusinessTrustSignals | null | undefined,
): BusinessBadgeTone {
  return isBusinessFullyVerified(account, business) ? "verified" : "unverified";
}
