import { supabase } from "@/lib/supabase";

export type FeedAudiencePost = {
  target_audience?: "customers" | "vendors" | "both" | null;
  target_category_id?: string | null;
};

/**
 * Mirrors get_local_feed_posts audience + target_category_id rules for the
 * client-side LocalFeed fallback when the RPC is unavailable.
 */
export async function filterPostsByAudienceAndCategory<T extends FeedAudiencePost>(
  posts: T[],
  readerVendorId: string | null,
): Promise<T[]> {
  const isVendor = Boolean(readerVendorId?.trim());
  if (!isVendor) {
    return posts.filter((post) => {
      const audience = post.target_audience ?? "customers";
      return audience === "customers" || audience === "both";
    });
  }

  const { data: vcRows, error } = await supabase
    .from("vendor_categories")
    .select("category_id")
    .eq("vendor_id", readerVendorId!)
    .eq("status", "approved");
  if (error) {
    console.error("filterPostsByAudienceAndCategory vendor_categories", error);
    // Fail closed for category-scoped posts when membership cannot be resolved.
    return posts.filter((post) => {
      const audience = post.target_audience ?? "customers";
      return (
        (audience === "vendors" || audience === "both") && post.target_category_id == null
      );
    });
  }
  const readerCategoryIds = new Set((vcRows ?? []).map((row) => row.category_id));

  return posts.filter((post) => {
    const audience = post.target_audience ?? "customers";
    if (audience !== "vendors" && audience !== "both") return false;
    if (post.target_category_id == null) return true;
    return readerCategoryIds.has(post.target_category_id);
  });
}
