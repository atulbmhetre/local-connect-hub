import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";
import { checkAndNotifyAdminGreenReady } from "@/lib/vendorGreenReady";

/** Re-read vendor_reviews and update vendors.avg_rating + review_count (same logic as RatingSheet). */
export async function syncVendorRatingFromReviews(
  vendorId: string,
  options?: { shopName?: string; alertAdmin?: boolean },
): Promise<void> {
  const runSync = () =>
    supabase.rpc("recalculate_vendor_rating_stats", {
      p_vendor_id: vendorId,
      p_alert_admin: options?.alertAdmin ?? false,
    });

  let { error } = await runSync();
  if (error) {
    // The review already saved and the sheet reports success to the user, so a
    // failed stats sync silently drifts avg_rating/review_count. Retry once,
    // then log with context if it still fails.
    ({ error } = await runSync());
  }
  if (error) {
    captureError(error, {
      scope: "vendorRating.recalculateStats",
      vendorId,
      alertAdmin: options?.alertAdmin ?? false,
    });
    console.error("recalculate_vendor_rating_stats", error);
    return;
  }
  void checkAndNotifyAdminGreenReady(vendorId, { shopName: options?.shopName });
}
