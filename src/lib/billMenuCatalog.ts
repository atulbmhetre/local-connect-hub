import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";
import { parseBillQuantity } from "@/lib/billEdit";

export type BillCatalogMenuItem = {
  id: string;
  name: string;
  price: number;
  unit: string | null;
  category_id: string | null;
  sort_order?: number | null;
};

/** Minimal bill-line shape for catalog tap/increment. */
export type BillCatalogLine = {
  id: string;
  description: string;
  quantity: string;
  unit: string;
  unit_price: string;
  menu_item_id?: string | null;
};

export async function fetchVendorBillCatalog(
  vendorId: string,
): Promise<{ items: BillCatalogMenuItem[]; error: boolean }> {
  const { data, error } = await supabase
    .from("vendor_menu_items")
    .select("id, name, price, unit, category_id, sort_order")
    .eq("vendor_id", vendorId)
    .eq("is_available", true)
    .order("sort_order", { ascending: true });

  if (error) {
    captureError(error, { scope: "billMenuCatalog.fetch", vendorId });
    return { items: [], error: true };
  }

  return {
    error: false,
    items: (data ?? []).map((row) => ({
      id: String(row.id),
      name: String(row.name ?? "").trim() || "Item",
      price: Number(row.price) || 0,
      unit: row.unit != null ? String(row.unit) : null,
      category_id: row.category_id != null ? String(row.category_id) : null,
      sort_order: row.sort_order != null ? Number(row.sort_order) : null,
    })),
  };
}

function isBlankPlaceholderLine(line: BillCatalogLine): boolean {
  return (
    !line.description.trim() &&
    !line.unit_price.trim() &&
    !line.menu_item_id &&
    (line.quantity === "" || parseBillQuantity(line.quantity) === 1)
  );
}

export function lineFromCatalogItem(item: BillCatalogMenuItem): BillCatalogLine {
  return {
    id: crypto.randomUUID(),
    description: item.name,
    quantity: "1",
    unit: item.unit?.trim() || "",
    unit_price: item.price > 0 ? String(item.price) : "",
    menu_item_id: item.id,
  };
}

/**
 * Tap a catalog item: increment qty on an existing menu-sourced line, else add
 * a new line (replacing a sole blank placeholder when present).
 */
export function applyCatalogItemTap<T extends BillCatalogLine>(
  lines: T[],
  item: BillCatalogMenuItem,
  createBlank: () => T,
): T[] {
  const existing = lines.find((l) => l.menu_item_id === item.id);
  if (existing) {
    return lines.map((l) =>
      l.id === existing.id
        ? {
            ...l,
            quantity: String(parseBillQuantity(l.quantity) + 1),
          }
        : l,
    );
  }

  const nextLine = {
    ...createBlank(),
    ...lineFromCatalogItem(item),
  } as T;

  if (lines.length === 1 && isBlankPlaceholderLine(lines[0])) {
    return [nextLine];
  }
  return [...lines, nextLine];
}
