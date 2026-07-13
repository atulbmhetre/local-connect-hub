/** Pan-city / nationwide post reach (matches PAN_INDIA_RADIUS_KM convention). */
export const FEED_REACH_CITY_WIDE_KM = 9999;

export const DEFAULT_FEED_REACH_KM = 5;

export const FEED_REACH_CHIP_OPTIONS = [1, 2, 5, 10, 25] as const;

export type FeedReachChipKm = (typeof FEED_REACH_CHIP_OPTIONS)[number];

/** Modest radii a customer may choose when composing a community post (no city/nationwide). */
export const CUSTOMER_FEED_REACH_CHIP_OPTIONS: number[] = [...FEED_REACH_CHIP_OPTIONS];

/** Max modest radius for customer posts (km). */
export const MAX_CUSTOMER_FEED_REACH_KM = Math.max(...FEED_REACH_CHIP_OPTIONS);

/** Radii a vendor may choose for an offer — includes full city / nationwide. */
export const VENDOR_FEED_REACH_CHIP_OPTIONS: number[] = [
  ...FEED_REACH_CHIP_OPTIONS,
  FEED_REACH_CITY_WIDE_KM,
];

export function isFeedCityWideKm(km: number | null | undefined): boolean {
  return km == null || km === 0 || km >= FEED_REACH_CITY_WIDE_KM;
}

export function normalizeFeedReachKm(km: number | null | undefined): number {
  if (km == null || km === 0) return DEFAULT_FEED_REACH_KM;
  if (km >= FEED_REACH_CITY_WIDE_KM) return FEED_REACH_CITY_WIDE_KM;
  return km;
}

/** Clamp a customer post reach so city/nationwide cannot be stored. */
export function clampCustomerFeedReachKm(km: number | null | undefined): number {
  const n = normalizeFeedReachKm(km);
  if (isFeedCityWideKm(n)) return MAX_CUSTOMER_FEED_REACH_KM;
  return Math.min(n, MAX_CUSTOMER_FEED_REACH_KM);
}

/** Reader discovery: NULL means no reader-side cap (city-wide). */
export function feedReachChipOptionsUpTo(maxKm: number | null | undefined): number[] {
  if (maxKm == null || isFeedCityWideKm(maxKm)) {
    return [...FEED_REACH_CHIP_OPTIONS, FEED_REACH_CITY_WIDE_KM];
  }
  const capped = FEED_REACH_CHIP_OPTIONS.filter((km) => km <= maxKm);
  if (maxKm >= FEED_REACH_CITY_WIDE_KM) {
    return [...capped, FEED_REACH_CITY_WIDE_KM];
  }
  return capped.length > 0 ? capped : [FEED_REACH_CHIP_OPTIONS[0]];
}

export function capFeedReachToMax(
  selected: number,
  maxKm: number | null | undefined,
): number {
  if (maxKm == null || isFeedCityWideKm(maxKm)) return selected;
  if (isFeedCityWideKm(selected)) return maxKm >= FEED_REACH_CITY_WIDE_KM ? FEED_REACH_CITY_WIDE_KM : maxKm;
  return Math.min(selected, maxKm);
}
