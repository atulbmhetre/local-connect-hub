/** Pure helpers for category-scoped menus, cancel reasons, brand/reach/radius. */

export type CategoryScopedProfile = {
  brand_name?: string | null;
  serves_at_vendor_place?: boolean | null;
  serves_at_customer_place?: boolean | null;
  service_radius_km?: number | null;
};

/** Prefer category brand when in matched-category context; else account shop_name. */
export function resolveCategoryBrandName(
  categoryBrand: string | null | undefined,
  accountShopName: string | null | undefined,
  matchedCategoryId?: string | null,
): string {
  if (matchedCategoryId) {
    const brand = String(categoryBrand ?? "").trim();
    if (brand) return brand;
  }
  return String(accountShopName ?? "").trim();
}

export function resolveCategoryReach(
  category: Pick<
    CategoryScopedProfile,
    "serves_at_vendor_place" | "serves_at_customer_place"
  > | null | undefined,
  account: {
    serves_at_vendor_place?: boolean | null;
    serves_at_customer_place?: boolean | null;
  },
  matchedCategoryId?: string | null,
): { serves_at_vendor_place: boolean; serves_at_customer_place: boolean } {
  if (matchedCategoryId && category) {
    const v = category.serves_at_vendor_place;
    const c = category.serves_at_customer_place;
    if (v != null || c != null) {
      return {
        serves_at_vendor_place: v === true,
        serves_at_customer_place: c === true,
      };
    }
  }
  return {
    serves_at_vendor_place: account.serves_at_vendor_place === true,
    serves_at_customer_place: account.serves_at_customer_place === true,
  };
}

export function resolveCategoryServiceRadius(
  categoryRadius: number | null | undefined,
  accountRadius: number | null | undefined,
  matchedCategoryId?: string | null,
): number | null | undefined {
  if (matchedCategoryId && categoryRadius != null && Number.isFinite(Number(categoryRadius))) {
    return Number(categoryRadius);
  }
  return accountRadius;
}

/** Customer-facing note: per-business when category context is known, else account fallback. */
export function resolveCategoryVendorNote(
  categoryNote: string | null | undefined,
  accountNote: string | null | undefined,
  matchedCategoryId?: string | null,
): string | null {
  if (matchedCategoryId) {
    const note = String(categoryNote ?? "").trim();
    if (note) return note;
  }
  const account = String(accountNote ?? "").trim();
  return account || null;
}

/** Honest Help Radar labels from serves_at_* reach flags. */
export function formatRadarReachLabels(
  reach: { serves_at_vendor_place: boolean; serves_at_customer_place: boolean },
  distKm: number | null,
  labels: {
    comesToYou: string;
    visitThemKm: (km: string) => string;
    visitThemMtr: (m: string) => string;
  },
): string[] {
  const out: string[] = [];
  if (reach.serves_at_customer_place) {
    out.push(labels.comesToYou);
  }
  if (reach.serves_at_vendor_place) {
    if (distKm != null && Number.isFinite(distKm)) {
      if (distKm < 1) {
        out.push(labels.visitThemMtr(String(Math.round(distKm * 1000))));
      } else {
        out.push(labels.visitThemKm(distKm.toFixed(1)));
      }
    } else {
      out.push(labels.visitThemKm("?"));
    }
  }
  return out;
}

/** Account defaults applied when a new category is selected in the UI (before save). */
export function inheritCategorySettingsFromAccount(account: {
  shop_name?: string | null;
  serves_at_vendor_place?: boolean | null;
  serves_at_customer_place?: boolean | null;
  service_radius_km?: number | null;
}): Required<CategoryScopedProfile> {
  const vendorPlace = account.serves_at_vendor_place === true;
  const customerPlace = account.serves_at_customer_place === true;
  return {
    brand_name: String(account.shop_name ?? "").trim() || null,
    serves_at_vendor_place: vendorPlace,
    serves_at_customer_place: customerPlace || (!vendorPlace && !customerPlace),
    service_radius_km:
      account.service_radius_km != null && Number.isFinite(Number(account.service_radius_km))
        ? Number(account.service_radius_km)
        : null,
  };
}

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

/** Customer-facing reputation for one vendor business (Radar / AiBridge). */
export type VendorCategoryReputation = {
  vendorId: string;
  categoryId: string;
  /** Fulfilled/done count for this category — used as helped or delivered by mode. */
  fulfilled: number;
  onTimeRate: number | null;
};

export function vendorCategoryReputationKey(vendorId: string, categoryId: string): string {
  return `${vendorId}:${categoryId}`;
}

export function mapPublicCategoryOrderStats(
  rows: Array<{
    vendor_id: string;
    category_id: string;
    fulfilled: number | null;
    on_time_rate: number | null;
  }>,
): Map<string, VendorCategoryReputation> {
  const map = new Map<string, VendorCategoryReputation>();
  for (const row of rows) {
    if (!row.vendor_id || !row.category_id) continue;
    map.set(vendorCategoryReputationKey(row.vendor_id, row.category_id), {
      vendorId: row.vendor_id,
      categoryId: row.category_id,
      fulfilled: Math.max(0, Number(row.fulfilled) || 0),
      onTimeRate:
        row.on_time_rate != null && Number.isFinite(Number(row.on_time_rate))
          ? Number(row.on_time_rate)
          : null,
    });
  }
  return map;
}

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
