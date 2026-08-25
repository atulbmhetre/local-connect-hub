/** One Radar/neighbour card = one vendor_categories row. Never merge or pick primary. */

export type RadarModeMatch = {
  vendor_id: string;
  category_id: string;
};

export type RadarBusinessPin = {
  latitude?: number | null;
  longitude?: number | null;
  upi_id?: string | null;
  upi_qr_url?: string | null;
  upi_qr_payee_id?: string | null;
  shop_photo_url?: string | null;
};

/** Stable list key: one card per (vendor, business). */
export function radarResultKey(vendorId: string, categoryId: string): string {
  return `${vendorId}:${categoryId}`;
}

/** Reject missing/sentinel pins. Discovery never falls back to vendors.lat/lng. */
export function usableRadarShopPin(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): { lat: number; lng: number } | null {
  if (latitude == null || longitude == null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude === 0 && longitude === 0) return null;
  return { lat: latitude, lng: longitude };
}

/**
 * Expand mode-match RPC rows into one card identity per matching business.
 * Same vendor with Mechanic + Nursery → two entries. Never collapse to cats[0].
 */
export function expandRadarModeMatches(matches: RadarModeMatch[]): RadarModeMatch[] {
  const seen = new Set<string>();
  const out: RadarModeMatch[] = [];
  for (const row of matches) {
    const vendorId = String(row.vendor_id ?? "").trim();
    const categoryId = String(row.category_id ?? "").trim();
    if (!vendorId || !categoryId) continue;
    const key = radarResultKey(vendorId, categoryId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ vendor_id: vendorId, category_id: categoryId });
  }
  return out;
}

export function stampVendorWithBusiness<T extends Record<string, unknown>>(
  vendor: T,
  business: RadarBusinessPin,
): T & {
  latitude: number | null;
  longitude: number | null;
  upi_id: string;
  upi_qr_url: string | null;
  upi_qr_payee_id: string | null;
} {
  const pin = usableRadarShopPin(business.latitude, business.longitude);
  return {
    ...vendor,
    latitude: pin?.lat ?? null,
    longitude: pin?.lng ?? null,
    upi_id: String(business.upi_id ?? "").trim(),
    upi_qr_url: business.upi_qr_url ?? null,
    upi_qr_payee_id: business.upi_qr_payee_id ?? null,
    shop_photo_url: business.shop_photo_url ?? vendor.shop_photo_url ?? null,
  };
}
