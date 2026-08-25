/** Admin verify/list: GPS + UPI from the picked vendor_categories row only. */

export type AdminBusinessPayeeFields = {
  category_id?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  upi_id?: string | null;
  shop_photo_url?: string | null;
  gps_match_distance?: number | null;
};

export type AdminBusinessPayeeView = {
  hasBusiness: boolean;
  latitude: number | null;
  longitude: number | null;
  upiId: string | null;
  shopPhotoUrl: string | null;
  gpsMatchDistance: number | null;
};

/**
 * When a business is picked, show that row's pin/UPI.
 * No vendor_categories row → not verifiable; never vendors.upi_id / vendors.latitude.
 */
export function resolveAdminBusinessPayeeAndPin(
  category: AdminBusinessPayeeFields | null | undefined,
): AdminBusinessPayeeView {
  const categoryId = String(category?.category_id ?? "").trim();
  if (!categoryId) {
    return {
      hasBusiness: false,
      latitude: null,
      longitude: null,
      upiId: null,
      shopPhotoUrl: null,
      gpsMatchDistance: null,
    };
  }
  const upi = String(category?.upi_id ?? "").trim();
  return {
    hasBusiness: true,
    latitude:
      category?.latitude != null && Number.isFinite(Number(category.latitude))
        ? Number(category.latitude)
        : null,
    longitude:
      category?.longitude != null && Number.isFinite(Number(category.longitude))
        ? Number(category.longitude)
        : null,
    upiId: upi || null,
    shopPhotoUrl: String(category?.shop_photo_url ?? "").trim() || null,
    gpsMatchDistance:
      category?.gps_match_distance != null &&
      Number.isFinite(Number(category.gps_match_distance))
        ? Number(category.gps_match_distance)
        : null,
  };
}
