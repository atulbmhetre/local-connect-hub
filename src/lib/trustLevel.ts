export type TrustLevel = "Diamond" | "Gold" | "Silver" | "Bronze" | "Unverified";

export type VendorVerificationRow = {
  vendor_id: string;
  check_type: string;
  status: string;
  is_latest?: boolean | null;
};

const TRUST_LEVEL_ORDER: TrustLevel[] = [
  "Unverified",
  "Bronze",
  "Silver",
  "Gold",
  "Diamond",
];

const BRONZE_CHECKS = ["photo_shop", "photo_selfie", "gps", "upi_format"] as const;
const SILVER_EXTRA = ["admin_check"] as const;
const GOLD_EXTRA = ["upi_pennydrop"] as const;
const DIAMOND_EXTRA = ["aadhaar_digilocker"] as const;

export function trustLevelRank(level: TrustLevel): number {
  return TRUST_LEVEL_ORDER.indexOf(level);
}

function passedChecksForVendor(
  vendorId: string,
  verifications: VendorVerificationRow[],
): Set<string> {
  const passed = new Set<string>();
  for (const row of verifications) {
    if (row.vendor_id !== vendorId) continue;
    if (row.is_latest === false) continue;
    if (row.status === "passed") passed.add(row.check_type);
  }
  return passed;
}

function hasAll(checks: readonly string[], passed: Set<string>): boolean {
  return checks.every((check) => passed.has(check));
}

/** Compute trust tier from latest passed verification checks for one vendor. */
export function computeTrustLevel(
  vendorId: string,
  verifications: VendorVerificationRow[],
): TrustLevel {
  const passed = passedChecksForVendor(vendorId, verifications);

  if (
    hasAll(BRONZE_CHECKS, passed) &&
    hasAll(SILVER_EXTRA, passed) &&
    hasAll(GOLD_EXTRA, passed) &&
    hasAll(DIAMOND_EXTRA, passed)
  ) {
    return "Diamond";
  }
  if (
    hasAll(BRONZE_CHECKS, passed) &&
    hasAll(SILVER_EXTRA, passed) &&
    hasAll(GOLD_EXTRA, passed)
  ) {
    return "Gold";
  }
  if (hasAll(BRONZE_CHECKS, passed) && hasAll(SILVER_EXTRA, passed)) {
    return "Silver";
  }
  if (hasAll(BRONZE_CHECKS, passed)) {
    return "Bronze";
  }
  return "Unverified";
}

/** Batch trust levels for many vendors from one verification result set. */
export function computeTrustLevelsByVendor(
  vendorIds: string[],
  verifications: VendorVerificationRow[],
): Map<string, TrustLevel> {
  const map = new Map<string, TrustLevel>();
  for (const vendorId of vendorIds) {
    map.set(vendorId, computeTrustLevel(vendorId, verifications));
  }
  return map;
}

/** Sort comparator helper: if distance gap > 500 m, closer vendor wins; else trust then distance. */
export const DISTANCE_OVERRIDES_TRUST_KM = 0.5;

export function compareRadarResults(
  a: { dist: number | null; trustLevel: TrustLevel },
  b: { dist: number | null; trustLevel: TrustLevel },
): number {
  const aDist = a.dist ?? Infinity;
  const bDist = b.dist ?? Infinity;

  if (Math.abs(aDist - bDist) > DISTANCE_OVERRIDES_TRUST_KM) {
    return aDist - bDist;
  }

  const trustDiff = trustLevelRank(b.trustLevel) - trustLevelRank(a.trustLevel);
  if (trustDiff !== 0) return trustDiff;

  return aDist - bDist;
}
