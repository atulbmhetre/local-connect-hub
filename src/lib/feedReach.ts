/** Pan-city post reach (matches PAN_INDIA_RADIUS_KM convention). */
export const FEED_REACH_CITY_WIDE_KM = 9999;

export const DEFAULT_FEED_REACH_KM = 5;

export const FEED_REACH_CHIP_OPTIONS = [1, 2, 5, 10, 25] as const;

export type FeedReachChipKm = (typeof FEED_REACH_CHIP_OPTIONS)[number];

export function isFeedCityWideKm(km: number | null | undefined): boolean {
  return km == null || km === 0 || km >= FEED_REACH_CITY_WIDE_KM;
}

export function normalizeFeedReachKm(km: number | null | undefined): number {
  if (km == null || km === 0) return DEFAULT_FEED_REACH_KM;
  if (km >= FEED_REACH_CITY_WIDE_KM) return FEED_REACH_CITY_WIDE_KM;
  return km;
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
