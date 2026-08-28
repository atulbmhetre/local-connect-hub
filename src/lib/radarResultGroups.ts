/**
 * Phase 7: group Radar vendor cards by matched category when a search
 * resolves to more than one category. Single-category searches stay flat.
 */

export type RadarCategoryGroupMeta = {
  categoryId: string;
  label: string;
  emoji: string;
};

export type RadarGroupableResult = {
  dist: number | null;
  vendor: {
    categories: Array<{
      category_id?: string | null;
      label?: string | null;
      emoji?: string | null;
    }>;
  };
};

export function matchedRadarCategoryMeta(
  item: RadarGroupableResult,
): RadarCategoryGroupMeta | null {
  const cat = item.vendor.categories[0];
  const categoryId = cat?.category_id?.trim();
  const label = cat?.label?.trim();
  if (!categoryId || !label) return null;
  return {
    categoryId,
    label,
    emoji: cat?.emoji?.trim() || "✨",
  };
}

/**
 * Preserve relative order within each group (caller should pre-sort by dist/trust).
 * Groups ordered by nearest result in the group (null dist last), then label.
 */
export function groupRadarResultsByCategory<T extends RadarGroupableResult>(
  results: T[],
): {
  shouldGroup: boolean;
  groups: Array<RadarCategoryGroupMeta & { items: T[] }>;
} {
  const byId = new Map<string, RadarCategoryGroupMeta & { items: T[] }>();

  for (const item of results) {
    const meta = matchedRadarCategoryMeta(item);
    if (!meta) continue;
    const existing = byId.get(meta.categoryId);
    if (existing) {
      existing.items.push(item);
    } else {
      byId.set(meta.categoryId, { ...meta, items: [item] });
    }
  }

  const groups = [...byId.values()].sort((a, b) => {
    const aDist = a.items.find((i) => i.dist != null)?.dist ?? Number.POSITIVE_INFINITY;
    const bDist = b.items.find((i) => i.dist != null)?.dist ?? Number.POSITIVE_INFINITY;
    if (aDist !== bDist) return aDist - bDist;
    return a.label.localeCompare(b.label);
  });

  return {
    shouldGroup: groups.length > 1,
    groups,
  };
}
