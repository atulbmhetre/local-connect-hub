/** Pure helpers for category-scoped menus and cancel-reason fallback. */

export type MenuItemWithCategory = {
  id?: string;
  name: string;
  price: number;
  unit?: string | null;
  category_id?: string | null;
  [key: string]: unknown;
};

/** When a matched category is known, show only that category's items (null category_id excluded). */
export function filterMenuItemsByCategoryContext<T extends MenuItemWithCategory>(
  items: T[],
  matchedCategoryId: string | null | undefined,
): T[] {
  const cat = matchedCategoryId?.trim() || null;
  if (!cat) return items;
  return items.filter((item) => item.category_id === cat);
}

export function groupMenuItemsByCategory<T extends MenuItemWithCategory>(
  items: T[],
  labelByCategoryId: Map<string, string>,
): { categoryId: string | null; label: string; items: T[] }[] {
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const key = item.category_id ?? null;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const result: { categoryId: string | null; label: string; items: T[] }[] = [];
  for (const [categoryId, groupItems] of groups) {
    result.push({
      categoryId,
      label:
        categoryId != null
          ? (labelByCategoryId.get(categoryId) ?? "Menu")
          : "Menu",
      items: groupItems,
    });
  }
  result.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}

/**
 * Prefer non-empty category-specific reasons; otherwise account-level cancel_reason_1–4.
 */
export function resolveCancelReasonsForCategory(
  categoryId: string | null | undefined,
  reasonsByCategoryId: Map<string, string[]>,
  accountLevel: (string | null | undefined)[],
): string[] {
  const cat = categoryId?.trim() || null;
  if (cat) {
    const specific = reasonsByCategoryId.get(cat) ?? [];
    const cleaned = specific
      .map((r) => String(r ?? "").trim())
      .filter((r) => r.length > 0);
    if (cleaned.length > 0) return cleaned;
  }
  return accountLevel
    .map((r) => (r == null ? "" : String(r).trim()))
    .filter((r) => r.length > 0);
}

export type CategoryOrderStat = {
  categoryId: string | null;
  label: string;
  total: number;
  fulfilled: number;
  declined: number;
  cancelled: number;
  onTimeRate: number | null;
};

type RequestStatRow = {
  status: string | null;
  appointment_status?: string | null;
  category_id?: string | null;
  delivery_slot_deadline?: string | null;
  fulfilled_at?: string | null;
};

export function buildCategoryOrderStats(
  rows: RequestStatRow[],
  labelByCategoryId: Map<string, string>,
): CategoryOrderStat[] {
  const byCat = new Map<string | null, RequestStatRow[]>();
  for (const row of rows) {
    const key = row.category_id ?? null;
    const list = byCat.get(key) ?? [];
    list.push(row);
    byCat.set(key, list);
  }

  const stats: CategoryOrderStat[] = [];
  for (const [categoryId, group] of byCat) {
    const withDeadline = group.filter(
      (o) =>
        (o.status === "fulfilled" || o.status === "done") &&
        o.delivery_slot_deadline &&
        o.fulfilled_at,
    );
    let onTimeRate: number | null = null;
    if (withDeadline.length > 0) {
      const onTime = withDeadline.filter(
        (o) =>
          new Date(o.fulfilled_at!).getTime() <=
          new Date(o.delivery_slot_deadline!).getTime(),
      ).length;
      onTimeRate = (onTime / withDeadline.length) * 100;
    }
    stats.push({
      categoryId,
      label:
        categoryId != null
          ? (labelByCategoryId.get(categoryId) ?? "Other")
          : "Uncategorized",
      total: group.length,
      fulfilled: group.filter(
        (o) => o.status === "fulfilled" || o.status === "done",
      ).length,
      declined: group.filter((o) => o.appointment_status === "declined").length,
      cancelled: group.filter((o) => o.status === "cancelled").length,
      onTimeRate,
    });
  }
  stats.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return stats;
}
