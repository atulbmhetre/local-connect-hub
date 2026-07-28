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
