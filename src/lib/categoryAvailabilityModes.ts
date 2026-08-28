import type { CategoryServiceMode } from "@/lib/categories";
import type { AvailabilityMode } from "@/lib/vendorRegistration";

/** Normalize DB/catalog service_mode to help | delivery | appointment. */
export function resolveCatalogServiceMode(
  raw: string | null | undefined,
): CategoryServiceMode {
  const mode = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (mode === "help" || mode === "delivery" || mode === "appointment") return mode;
  if (mode === "booking") return "appointment";
  return "help";
}

/** Default vendor_category_modes when a category is first selected in the UI.
 * Help/Appointment start empty — vendor must pick Urgent / Scheduled / Both.
 * Delivery still defaults to delivery (separate deliver-vs-pickup question).
 */
export function initialModesForCatalog(catalog: CategoryServiceMode): AvailabilityMode[] {
  switch (catalog) {
    case "help":
    case "appointment":
      return [];
    case "delivery":
      return ["delivery"];
    default:
      return [];
  }
}

/**
 * Keep only modes valid for the catalog type.
 * Help/Appointment: help and/or appointment (empty allowed until the vendor picks).
 * Delivery-default: delivery OR appointment (shop pickup); empty → delivery.
 */
export function ensureCatalogBaseModes(
  modes: readonly string[] | null | undefined,
  catalog: CategoryServiceMode,
): AvailabilityMode[] {
  const normalized = normalizeAvailabilityModes(modes);
  if (catalog === "help" || catalog === "appointment") {
    const next: AvailabilityMode[] = [];
    if (normalized.includes("help")) next.push("help");
    if (normalized.includes("appointment")) next.push("appointment");
    return next;
  }
  if (normalized.includes("delivery")) return ["delivery"];
  if (normalized.includes("appointment")) return ["appointment"];
  return ["delivery"];
}

/** Three-way Help↔Appointment choice for the mode selector (null = nothing picked yet). */
export type HelpAppointmentChoice = "urgent" | "scheduled" | "both";

export function helpAppointmentModesToChoice(
  modes: readonly string[] | null | undefined,
): HelpAppointmentChoice | null {
  const normalized = normalizeAvailabilityModes(modes);
  const hasHelp = normalized.includes("help");
  const hasAppt = normalized.includes("appointment");
  if (hasHelp && hasAppt) return "both";
  if (hasHelp) return "urgent";
  if (hasAppt) return "scheduled";
  return null;
}

export function helpAppointmentChoiceToModes(
  choice: HelpAppointmentChoice,
): AvailabilityMode[] {
  if (choice === "urgent") return ["help"];
  if (choice === "scheduled") return ["appointment"];
  return ["help", "appointment"];
}

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

/** Toggle one mode in a multi-select list (at least one must remain). */
export function toggleAvailabilityMode(
  modes: readonly AvailabilityMode[],
  mode: AvailabilityMode,
  opts?: { allowEmpty?: boolean },
): AvailabilityMode[] {
  if (!isAvailabilityMode(mode)) return normalizeAvailabilityModes(modes);
  const current = normalizeAvailabilityModes(modes);
  const has = current.includes(mode);
  if (has) {
    if (current.length === 1 && !opts?.allowEmpty) return current;
    return current.filter((m) => m !== mode);
  }
  return normalizeAvailabilityModes([...current, mode]);
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
 * Sends the full normalized multi-mode array per category.
 */
export function buildCategoryModesPayload(
  categoryIds: readonly string[],
  modesById: Record<string, AvailabilityMode[] | undefined>,
  _catalogModeById?: Record<string, string | null | undefined>,
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
