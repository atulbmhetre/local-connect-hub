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

export function toggleAvailabilityMode(
  modes: readonly AvailabilityMode[],
  mode: AvailabilityMode,
  opts?: { allowEmpty?: boolean },
): AvailabilityMode[] {
  const has = modes.includes(mode);
  if (has) {
    if (!opts?.allowEmpty && modes.length <= 1) return [...modes];
    return normalizeAvailabilityModes(modes.filter((m) => m !== mode));
  }
  return normalizeAvailabilityModes([...modes, mode]);
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

/** JSONB map shape expected by register_vendor / vendor_update_categories. */
export function buildCategoryModesPayload(
  categoryIds: readonly string[],
  modesById: Record<string, AvailabilityMode[] | undefined>,
): Record<string, AvailabilityMode[]> {
  const out: Record<string, AvailabilityMode[]> = {};
  for (const id of categoryIds) {
    out[id] = normalizeAvailabilityModes(modesById[id]);
  }
  return out;
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
