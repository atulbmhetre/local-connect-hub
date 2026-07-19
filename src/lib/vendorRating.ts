import { supabase } from "@/lib/supabase";
import { checkAndNotifyAdminGreenReady } from "@/lib/vendorGreenReady";

/** Re-read vendor_reviews and update vendors.avg_rating + review_count (same logic as RatingSheet). */
export async function syncVendorRatingFromReviews(
  vendorId: string,
  options?: { shopName?: string; alertAdmin?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("recalculate_vendor_rating_stats", {
    p_vendor_id: vendorId,
    p_alert_admin: options?.alertAdmin ?? false,
  });
  if (error) {
    console.error("recalculate_vendor_rating_stats", error);
    return;
  }
  void checkAndNotifyAdminGreenReady(vendorId, { shopName: options?.shopName });
}
