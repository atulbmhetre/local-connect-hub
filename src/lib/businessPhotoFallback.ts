import { supabase } from "@/lib/supabase";
import type { BusinessLocationRow } from "@/lib/trustLevel";

/**
 * Fetch business-specific shop photos for given vendor+category pairs.
 * Returns a Map for efficient lookup by "vendorId:categoryId" key.
 */
export async function fetchBusinessPhotos(
  vendorCategoryPairs: Array<{ vendorId: string; categoryId: string }>
): Promise<Map<string, string | null>> {
  if (vendorCategoryPairs.length === 0) {
    return new Map();
  }

  const { data: businesses, error } = await supabase
    .from("vendor_categories")
    .select("vendor_id, category_id, shop_photo_url")
    .or(
      vendorCategoryPairs
        .map(({ vendorId, categoryId }) => 
          `and(vendor_id.eq.${vendorId},category_id.eq.${categoryId})`
        )
        .join(",")
    );

  if (error) {
    console.error("fetchBusinessPhotos error:", error);
    return new Map();
  }

  const photoMap = new Map<string, string | null>();
  for (const business of businesses || []) {
    const key = `${business.vendor_id}:${business.category_id}`;
    photoMap.set(key, business.shop_photo_url);
  }

  return photoMap;
}

/**
 * Get the business-specific photo for a vendor+category, falling back to account photo.
 * Use this pattern: business photo first, then account photo, then null.
 */
export function resolveVendorPhoto(
  businessPhotoMap: Map<string, string | null>,
  vendorId: string,
  categoryId: string | null | undefined,
  accountPhoto: string | null | undefined
): string | null {
  if (categoryId) {
    const key = `${vendorId}:${categoryId}`;
    const businessPhoto = businessPhotoMap.get(key);
    if (businessPhoto != null && String(businessPhoto).trim() !== "") {
      return businessPhoto;
    }
  }
  
  // Fall back to account photo
  return accountPhoto && String(accountPhoto).trim() !== "" ? accountPhoto : null;
}