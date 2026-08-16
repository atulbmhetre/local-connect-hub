const CATEGORY_ALIASES: Record<string, string> = {
  "Grocery Store": "Kirana Store",
  "Kirana Store": "Grocery Store",
};

export function categoryHasActiveVendor(label: string, activeLabels: Set<string>): boolean {
  if (activeLabels.has(label)) return true;
  const alias = CATEGORY_ALIASES[label];
  return alias != null && activeLabels.has(alias);
}

/** Match offer posts to a feed chip using vendors.category + vendor_categories union. */
export function offerMatchesCategory(
  vendorId: string | null | undefined,
  vendorCategory: string | null | undefined,
  chipLabel: string,
  vendorCategoryLabels: Map<string, Set<string>>,
): boolean {
  const labels =
    vendorId && vendorCategoryLabels.has(vendorId)
      ? vendorCategoryLabels.get(vendorId)!
      : vendorCategory
        ? new Set([vendorCategory])
        : new Set<string>();
  for (const lbl of labels) {
    if (lbl === chipLabel) return true;
    const alias = CATEGORY_ALIASES[chipLabel];
    if (alias != null && lbl === alias) return true;
  }
  return false;
}

/** Prefer business_category_id when present; fall back to label union for legacy offers. */
export function offerMatchesFeedCategory(
  post: {
    vendor_id?: string | null;
    business_category_id?: string | null;
    vendors?: { category?: string | null } | null;
  },
  selectedCategoryId: string | null,
  selectedCategoryLabel: string | null,
  vendorCategoryLabels: Map<string, Set<string>>,
): boolean {
  if (post.business_category_id && selectedCategoryId) {
    return post.business_category_id === selectedCategoryId;
  }
  if (!selectedCategoryLabel) return true;
  return offerMatchesCategory(
    post.vendor_id,
    post.vendors?.category,
    selectedCategoryLabel,
    vendorCategoryLabels,
  );
}
