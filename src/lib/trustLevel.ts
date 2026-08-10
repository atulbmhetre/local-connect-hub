import { gpsEffectiveTolerance } from "@/lib/gpsMatch";

export type TrustLevel = "Diamond" | "Gold" | "Silver" | "Bronze" | "Unverified";

export type VendorVerificationRow = {
  vendor_id: string;
  check_type: string;
  status: string;
  is_latest?: boolean | null;
};

/** Per-business location fields used to derive photo_shop / gps (not account VV). */
export type BusinessLocationRow = {
  vendor_id: string;
  category_id: string;
  shop_photo_url?: string | null;
  gps_match_distance?: number | null;
  location_accuracy?: number | null;
  photo_accuracy?: number | null;
  verification_status?: string | null;
};

const TRUST_LEVEL_ORDER: TrustLevel[] = [
  "Unverified",
  "Bronze",
  "Silver",
  "Gold",
  "Diamond",
];

export const BRONZE_CHECKS = ["upi_format", "photo_shop", "photo_selfie", "gps"] as const;
export const SILVER_EXTRA = ["admin_check"] as const;
export const GOLD_EXTRA = ["upi_pennydrop"] as const;
export const DIAMOND_EXTRA = ["aadhaar_digilocker"] as const;

/** Account-level checks stored on vendor_verification. */
export const ACCOUNT_TRUST_CHECKS = new Set<string>([
  "upi_format",
  "photo_selfie",
  "admin_check",
  "upi_pennydrop",
  "aadhaar_digilocker",
]);

/** Location checks derived from vendor_categories — never from account VV. */
export const BUSINESS_LOCATION_CHECKS = new Set<string>(["photo_shop", "gps"]);

/** Unbuilt external integrations — show "coming soon", never auto-pass. */
export const COMING_SOON_CHECKS = new Set<string>(["upi_pennydrop", "aadhaar_digilocker"]);

export type TrustTierGroup = {
  tier: Exclude<TrustLevel, "Unverified">;
  checks: readonly string[];
};

/** Display order for admin + TrustBadge detail sheets. */
export const TRUST_TIER_GROUPS: readonly TrustTierGroup[] = [
  { tier: "Bronze", checks: BRONZE_CHECKS },
  { tier: "Silver", checks: SILVER_EXTRA },
  { tier: "Gold", checks: GOLD_EXTRA },
  { tier: "Diamond", checks: DIAMOND_EXTRA },
] as const;

export function trustLevelRank(level: TrustLevel): number {
  return TRUST_LEVEL_ORDER.indexOf(level);
}

export function vendorCategoryTrustKey(vendorId: string, categoryId: string): string {
  return `${vendorId}:${categoryId}`;
}

function hasAll(checks: readonly string[], passed: Set<string>): boolean {
  return checks.every((check) => passed.has(check));
}

function ladderFromPassed(passed: Set<string>): TrustLevel {
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

/** Account-level passed checks only (ignores historical photo_shop/gps VV rows). */
export function accountPassedChecks(
  vendorId: string,
  verifications: VendorVerificationRow[],
): Set<string> {
  const passed = new Set<string>();
  for (const row of verifications) {
    if (row.vendor_id !== vendorId) continue;
    if (row.is_latest === false) continue;
    if (row.status !== "passed") continue;
    if (BUSINESS_LOCATION_CHECKS.has(row.check_type)) continue;
    passed.add(row.check_type);
  }
  return passed;
}

/** Derive photo_shop / gps pass from one vendor_categories row. */
export function deriveBusinessLocationPasses(row: BusinessLocationRow | null | undefined): {
  photo_shop: boolean;
  gps: boolean;
} {
  if (!row) return { photo_shop: false, gps: false };
  const softFail = row.verification_status === "pending_location_review";
  const hasPhoto = row.shop_photo_url != null && String(row.shop_photo_url).trim() !== "";
  const photo_shop = !softFail && hasPhoto;

  let gps = false;
  if (!softFail && row.gps_match_distance != null && Number.isFinite(Number(row.gps_match_distance))) {
    const tol = gpsEffectiveTolerance(row.location_accuracy, row.photo_accuracy);
    gps = Number(row.gps_match_distance) <= tol;
  }
  return { photo_shop, gps };
}

export function findBusinessLocationRow(
  vendorId: string,
  categoryId: string | null | undefined,
  businesses: BusinessLocationRow[],
): BusinessLocationRow | null {
  if (!categoryId) return null;
  return (
    businesses.find((b) => b.vendor_id === vendorId && b.category_id === categoryId) ?? null
  );
}

/**
 * Per-business trust tier: account identity/payment checks + this category's
 * derived photo_shop / gps.
 */
export function computeTrustLevelForBusiness(
  vendorId: string,
  categoryId: string | null | undefined,
  verifications: VendorVerificationRow[],
  businesses: BusinessLocationRow[],
): TrustLevel {
  const passed = accountPassedChecks(vendorId, verifications);
  const biz = findBusinessLocationRow(vendorId, categoryId, businesses);
  const loc = deriveBusinessLocationPasses(biz);
  if (loc.photo_shop) passed.add("photo_shop");
  if (loc.gps) passed.add("gps");
  return ladderFromPassed(passed);
}

/** @deprecated Prefer computeTrustLevelForBusiness — account-only fallback (no location). */
export function computeTrustLevel(
  vendorId: string,
  verifications: VendorVerificationRow[],
): TrustLevel {
  return ladderFromPassed(accountPassedChecks(vendorId, verifications));
}

export function tierReachedForBusiness(
  vendorId: string,
  categoryId: string | null | undefined,
  verifications: VendorVerificationRow[],
  businesses: BusinessLocationRow[],
  tier: Exclude<TrustLevel, "Unverified">,
): boolean {
  const level = computeTrustLevelForBusiness(vendorId, categoryId, verifications, businesses);
  return trustLevelRank(level) >= trustLevelRank(tier);
}

/** @deprecated Prefer tierReachedForBusiness. */
export function tierReached(
  vendorId: string,
  verifications: VendorVerificationRow[],
  tier: Exclude<TrustLevel, "Unverified">,
): boolean {
  const level = computeTrustLevel(vendorId, verifications);
  return trustLevelRank(level) >= trustLevelRank(tier);
}

/** Batch: Map key = `${vendorId}:${categoryId}`. */
export function computeTrustLevelsByVendorCategory(
  keys: Array<{ vendorId: string; categoryId: string }>,
  verifications: VendorVerificationRow[],
  businesses: BusinessLocationRow[],
): Map<string, TrustLevel> {
  const map = new Map<string, TrustLevel>();
  for (const { vendorId, categoryId } of keys) {
    map.set(
      vendorCategoryTrustKey(vendorId, categoryId),
      computeTrustLevelForBusiness(vendorId, categoryId, verifications, businesses),
    );
  }
  return map;
}

/** @deprecated Prefer computeTrustLevelsByVendorCategory. */
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

/** Status string for TrustBadge / admin check rows for one business. */
export function statusForBusinessCheck(
  checkType: string,
  vendorId: string,
  categoryId: string | null | undefined,
  verifications: VendorVerificationRow[],
  businesses: BusinessLocationRow[],
): string {
  if (COMING_SOON_CHECKS.has(checkType)) {
    const row = verifications.find(
      (r) =>
        r.vendor_id === vendorId &&
        r.check_type === checkType &&
        r.is_latest !== false,
    );
    const raw = row?.status ?? "dormant";
    if (raw === "passed" || raw === "failed") return raw;
    return "coming_soon";
  }
  if (BUSINESS_LOCATION_CHECKS.has(checkType)) {
    const loc = deriveBusinessLocationPasses(
      findBusinessLocationRow(vendorId, categoryId, businesses),
    );
    if (checkType === "photo_shop") return loc.photo_shop ? "passed" : "pending";
    if (checkType === "gps") return loc.gps ? "passed" : "pending";
  }
  const row = verifications.find(
    (r) =>
      r.vendor_id === vendorId && r.check_type === checkType && r.is_latest !== false,
  );
  const raw = row?.status ?? "pending";
  return raw === "passed" || raw === "failed" ? raw : "pending";
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
