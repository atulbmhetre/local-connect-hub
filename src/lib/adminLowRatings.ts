import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";

export type AdminLowRatingRow = {
  id: string;
  vendor_id: string;
  shop_name: string;
  rating: number;
  review_text: string | null;
  user_phone: string | null;
  created_at: string;
};

/** Admin Settings → Low Ratings list (2★ and below). */
export async function loadAdminLowRatings(
  vendorFallback: string,
): Promise<AdminLowRatingRow[]> {
  const { data, error } = await supabase
    .from("vendor_reviews")
    .select("id, vendor_id, rating, review_text, user_phone, created_at, vendors(shop_name)")
    .lte("rating", 2)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    captureError(error, { scope: "settings.loadLowRatings" });
    return [];
  }

  return (data ?? []).map((row) => {
    const vendorRaw = row.vendors as
      | { shop_name: string | null }
      | { shop_name: string | null }[]
      | null;
    const vendor = Array.isArray(vendorRaw) ? vendorRaw[0] : vendorRaw;
    return {
      id: row.id,
      vendor_id: row.vendor_id,
      shop_name: vendor?.shop_name?.trim() || vendorFallback,
      rating: row.rating,
      review_text: row.review_text,
      user_phone: row.user_phone,
      created_at: row.created_at,
    };
  });
}

/** Admin Settings → delete a low review via admin_delete_review (is_admin_session gate). */
export async function deleteAdminLowRating(
  row: Pick<AdminLowRatingRow, "id" | "vendor_id">,
  adminPhone: string | null,
): Promise<{ ok: true } | { ok: false; error: { message: string } }> {
  const { error } = await supabase.rpc("admin_delete_review", {
    p_admin_phone: adminPhone,
    p_review_id: row.id,
  });
  if (error) {
    captureError(error, {
      scope: "settings.deleteLowRating",
      reviewId: row.id,
      vendorId: row.vendor_id,
    });
    return { ok: false, error };
  }
  return { ok: true };
}
