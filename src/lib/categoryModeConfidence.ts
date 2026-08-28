/**
 * Fire-and-forget: after registration / mode edit, ask the DB whether any
 * category now has enough non-default-mode vendors to warrant an admin review.
 * Never blocks the caller; never affects search.
 */
export function triggerCategoryModeConfidenceCheck(categoryIds: string[]): void {
  const ids = [
    ...new Set(
      (categoryIds ?? [])
        .map((id) => String(id ?? "").trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (ids.length === 0) return;

  void (async () => {
    try {
      const { supabase } = await import("@/lib/supabase");
      const { error } = await supabase.rpc("maybe_flag_category_mode_reviews", {
        p_category_ids: ids,
      });
      if (error) console.warn("maybe_flag_category_mode_reviews", error.message);
    } catch (err) {
      console.warn("maybe_flag_category_mode_reviews failed", err);
    }
  })();
}
