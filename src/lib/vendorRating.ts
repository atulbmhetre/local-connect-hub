import { supabase } from "@/lib/supabase";
import { saveNotification } from "@/lib/notifications";
import { checkAndNotifyAdminGreenReady } from "@/lib/vendorGreenReady";

/** Re-read vendor_reviews and update vendors.avg_rating + review_count (same logic as RatingSheet). */
export async function syncVendorRatingFromReviews(
  vendorId: string,
  options?: { shopName?: string; alertAdmin?: boolean },
): Promise<void> {
  const { data: reviews } = await supabase
    .from("vendor_reviews")
    .select("rating")
    .eq("vendor_id", vendorId);

  if (!reviews?.length) {
    await supabase
      .from("vendors")
      .update({ avg_rating: null, review_count: 0, low_rating_admin_notified: false })
      .eq("id", vendorId);
    return;
  }

  const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;
  const avgRating = Math.round(avg * 10) / 10;
  const reviewCount = reviews.length;

  const update: {
    avg_rating: number;
    review_count: number;
    low_rating_admin_notified?: boolean;
  } = {
    avg_rating: avgRating,
    review_count: reviewCount,
  };

  if (avgRating > 3.5) {
    update.low_rating_admin_notified = false;
  }

  if (options?.alertAdmin && avgRating < 2.0 && reviewCount >= 5) {
    const { data: vendor } = await supabase
      .from("vendors")
      .select("low_rating_admin_notified")
      .eq("id", vendorId)
      .maybeSingle();

    if (!vendor?.low_rating_admin_notified) {
      const shopName = options.shopName?.trim() || "Vendor";
      const { data: configRow } = await supabase
        .from("app_config")
        .select("value")
        .eq("key", "admin_phone")
        .maybeSingle();
      const adminPhone = configRow?.value?.trim();
      if (adminPhone) {
        saveNotification({
          userPhone: adminPhone,
          type: "admin_alert",
          title: "Low rated vendor alert",
          body: `${shopName} has avg rating ${avgRating} over ${reviewCount} reviews`,
          route: "vendor",
          routeParams: { vendor_id: vendorId },
          isInformational: false,
        });
      }
      update.low_rating_admin_notified = true;
    }
  }

  await supabase.from("vendors").update(update).eq("id", vendorId);
  void checkAndNotifyAdminGreenReady(vendorId);
}
