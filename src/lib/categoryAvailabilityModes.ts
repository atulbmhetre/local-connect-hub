import type { AvailabilityMode } from "@/lib/vendorRegistration";

export const AVAILABILITY_MODE_ORDER: AvailabilityMode[] = [
  "help",
  "delivery",
  "appointment",
];

export function isAvailabilityMode(value: unknown): value is AvailabilityMode {
  return value === "help" || value === "delivery" || value === "appointment";
}

/** Deduplicate and order modes as help → delivery → appointment. */
export function normalizeAvailabilityModes(
  modes: readonly string[] | null | undefined,
): AvailabilityMode[] {
  const set = new Set<AvailabilityMode>();
  for (const raw of modes ?? []) {
    const mode = String(raw ?? "")
      .trim()
      .toLowerCase();
    if (isAvailabilityMode(mode)) set.add(mode);
  }
  return AVAILABILITY_MODE_ORDER.filter((m) => set.has(m));
}

/**
 * Compatibility primary for a category:
 * prefer catalog canonical when selected, else first in deterministic order.
 */
export function pickPrimaryAvailabilityMode(
  modes: readonly string[] | null | undefined,
  catalogMode?: string | null,
): AvailabilityMode {
  const normalized = normalizeAvailabilityModes(modes);
  if (normalized.length === 0) return "help";
  const catalog = String(catalogMode ?? "")
    .trim()
    .toLowerCase();
  if (isAvailabilityMode(catalog) && normalized.includes(catalog)) {
    return catalog;
  }
  return normalized[0];
}

/**
 * Uniselect: selecting a mode always replaces prior selection (single-element array).
 * Retapping the same mode keeps it selected (cannot clear via this helper).
 */
export function setAvailabilityMode(mode: AvailabilityMode): AvailabilityMode[] {
  return isAvailabilityMode(mode) ? [mode] : ["help"];
}

/** @deprecated Use setAvailabilityMode — availability is uniselect. */
export function toggleAvailabilityMode(
  _modes: readonly AvailabilityMode[],
  mode: AvailabilityMode,
  _opts?: { allowEmpty?: boolean },
): AvailabilityMode[] {
  return setAvailabilityMode(mode);
}

export function allCategoriesHaveModes(
  categoryIds: readonly string[],
  modesById: Record<string, AvailabilityMode[] | undefined>,
): boolean {
  if (categoryIds.length === 0) return false;
  return categoryIds.every(
    (id) => normalizeAvailabilityModes(modesById[id]).length > 0,
  );
}

/**
 * JSONB map shape expected by register_vendor / vendor_update_categories.
 * Always one mode per category (RPC still accepts text[]).
 */
export function buildCategoryModesPayload(
  categoryIds: readonly string[],
  modesById: Record<string, AvailabilityMode[] | undefined>,
  catalogModeById?: Record<string, string | null | undefined>,
): Record<string, AvailabilityMode[]> {
  const out: Record<string, AvailabilityMode[]> = {};
  for (const id of categoryIds) {
    out[id] = [
      pickPrimaryAvailabilityMode(modesById[id], catalogModeById?.[id]),
    ];
  }
  return out;
}

/** Coerce any stored mode list to a single-element selection for UI. */
export function coerceSingleAvailabilityMode(
  modes: readonly string[] | null | undefined,
  catalogMode?: string | null,
): AvailabilityMode[] {
  return [pickPrimaryAvailabilityMode(modes, catalogMode)];
}

export function unionAvailabilityModes(
  modesById: Record<string, AvailabilityMode[] | undefined>,
): AvailabilityMode[] {
  const set = new Set<AvailabilityMode>();
  for (const modes of Object.values(modesById)) {
    for (const m of normalizeAvailabilityModes(modes)) set.add(m);
  }
  return AVAILABILITY_MODE_ORDER.filter((m) => set.has(m));
}
