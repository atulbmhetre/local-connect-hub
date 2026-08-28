import {
  registerKnownCategoriesSeed,
  resolveCanonicalTerms,
  type CanonicalCategoryMatch,
} from "@/lib/categorySearchTerms";

export type CategoryServiceMode = "help" | "delivery" | "appointment";

export type KnownCategoryDef = {
  label: string;
  aliases: string[];
  service_mode: CategoryServiceMode;
  isEmergency: boolean;
};

export type { CanonicalCategoryMatch, FuzzyCanonicalMatch } from "@/lib/categorySearchTerms";
export {
  resolveCanonicalTerms,
  resolveFuzzyCanonicalTerms,
  resolveFuzzyCanonicalTermsLocal,
  FUZZY_CATEGORY_SIMILARITY_THRESHOLD,
} from "@/lib/categorySearchTerms";

/** @deprecated Prefer DB-backed category_search_terms via resolveCanonicalTerms. Kept for offline seed / rollback. */
export const KNOWN_CATEGORIES: Record<string, KnownCategoryDef> = {
  beautician: {
    label: "Beautician",
    aliases: [
      "butisian",
      "beautician",
      "parlour",
      "parlor",
      "beauty",
      "salon",
      "therapist",
      "therapy",
      "massage",
      "spa",
      "beauty parlour",
      "mehendi",
      "makeup artist",
      "nail art",
      "facial",
      "waxing",
    ],
    service_mode: "appointment",
    isEmergency: false,
  },
  grocery: {
    label: "Grocery Store",
    aliases: ["kirana", "grocery", "groceries", "general store", "dukan", "dukkan"],
    service_mode: "delivery",
    isEmergency: false,
  },
  mechanic: {
    label: "Mechanic",
    aliases: ["mikanik", "mechanic", "garage", "engine", "car repair", "bike repair"],
    service_mode: "help",
    isEmergency: true,
  },
  towing: {
    label: "Towing",
    aliases: ["towing", "tow", "tow truck", "breakdown", "crane"],
    service_mode: "help",
    isEmergency: true,
  },
  tyre: {
    label: "Tyre Service",
    aliases: ["tyre", "tire", "puncture", "flat tyre", "wheel"],
    service_mode: "help",
    isEmergency: true,
  },
  keyMaker: {
    label: "Key Maker",
    aliases: ["key", "keymaker", "locksmith", "duplicate key", "lock"],
    service_mode: "help",
    isEmergency: false,
  },
  ambulance: {
    label: "Ambulance",
    aliases: ["ambulance", "emergency", "accident", "108"],
    service_mode: "help",
    isEmergency: true,
  },
  pharmacy: {
    label: "Pharmacy",
    aliases: ["dawai", "dawa", "medicine", "pharmacy", "chemist", "medical", "drug store", "tablet"],
    service_mode: "delivery",
    isEmergency: false,
  },
  nursing: {
    label: "Nursing",
    aliases: ["nurse", "nursing", "caretaker", "home care", "patient care"],
    service_mode: "help",
    isEmergency: true,
  },
  plumber: {
    label: "Plumber",
    aliases: ["plumber", "pipe", "nal wala", "water", "plumbing", "leak", "tap"],
    service_mode: "help",
    isEmergency: false,
  },
  electrician: {
    label: "Electrician",
    aliases: [
      "bijli",
      "electrician",
      "light wala",
      "current wala",
      "electric",
      "wiring",
      "fuse",
      "power",
      "current",
    ],
    service_mode: "help",
    isEmergency: false,
  },
  security: {
    label: "Security",
    aliases: ["security", "guard", "watchman", "bouncer"],
    service_mode: "help",
    isEmergency: false,
  },
  fireBrigade: {
    label: "Fire Brigade",
    aliases: ["fire station", "fire brigade", "agni shaman", "agnishaman", "fire emergency"],
    service_mode: "help",
    isEmergency: true,
  },
};

registerKnownCategoriesSeed(() =>
  Object.values(KNOWN_CATEGORIES).map((c) => ({
    label: c.label,
    aliases: c.aliases,
  })),
);

const KNOWN_CATEGORY_LIST = Object.values(KNOWN_CATEGORIES);

/** Canonical labels for categories whose catalog default service_mode is help. */
export const HELP_DEFAULT_CATEGORY_LABELS: readonly string[] = KNOWN_CATEGORY_LIST.filter(
  (c) => c.service_mode === "help",
).map((c) => c.label);

const OFFICIAL_EMERGENCY_LABELS = new Set(
  KNOWN_CATEGORY_LIST.filter((c) => c.isEmergency).map((c) => c.label),
);

export const MEDICAL_EMERGENCY_LABELS = new Set(["Ambulance", "Pharmacy", "Nursing"]);
export const ROADSIDE_EMERGENCY_LABELS = new Set(["Mechanic", "Towing", "Tyre Service"]);
export const FIRE_EMERGENCY_LABELS = new Set(["Fire Brigade"]);

const PHARMACY_MEDICAL_RAW = /\b(medical|medicine|dawai|dawa|pharmacy|chemist|tablet)\b/;

/** DB category row for Tier-1 exact-match lookup (label required). */
export type Category = {
  label: string;
};

/** Tier 1: exact case-insensitive match against live DB categories. */
export async function resolveCategoryFromDB(
  term: string,
  dbCategories: Category[],
): Promise<string | null> {
  const t = term.trim();
  if (!t) return null;
  const match = dbCategories.find((c) => c.label.toLowerCase() === t.toLowerCase());
  return match?.label ?? null;
}

/**
 * Map free-text / voice input to a canonical category label, or null if no match.
 * Uses DB-backed category_search_terms (cache), with KNOWN_CATEGORIES seed as fallback.
 * @deprecated Prefer resolveCanonicalTerms for multi-category results.
 */
export function resolveCanonicalTerm(rawInput: string): string | null {
  return resolveCanonicalTerms(rawInput)[0]?.label ?? null;
}

/**
 * Ambulance / accident / hospital / standalone "emergency" — routes gov help to 108 (medical).
 * Vendor search still runs; this only affects helpline UI (not pharmacy's 104 path).
 */
export function isAmbulanceEmergencySearch(term: string): boolean {
  const raw = term.trim().toLowerCase();
  if (!raw) return false;
  if (/\bhospitals?\b/.test(raw)) return true;
  if (/\baccident\b/.test(raw)) return true;
  if (raw === "emergency") return true;
  return resolveCanonicalTerm(term) === "Ambulance";
}

/** Pharmacy / medical medicine searches — vendor results + soft 104 helpline card. */
export function isPharmacyMedicalSearch(term: string): boolean {
  if (isAmbulanceEmergencySearch(term)) return false;
  const raw = term.trim().toLowerCase();
  if (!raw) return false;
  if (resolveCanonicalTerm(term) === "Pharmacy") return true;
  return PHARMACY_MEDICAL_RAW.test(raw);
}

/** Official emergency helplines in Radar failsafe (excludes pharmacy/medical path). */
export function isOfficialEmergencyCategory(term: string): boolean {
  if (isAmbulanceEmergencySearch(term)) return true;
  const resolved = resolveCanonicalTerm(term);
  if (resolved && OFFICIAL_EMERGENCY_LABELS.has(resolved)) return true;
  const t = term.trim().toLowerCase();
  if (!t) return false;
  for (const label of OFFICIAL_EMERGENCY_LABELS) {
    if (label.toLowerCase() === t) return true;
  }
  return false;
}

/** Map vague hospital searches to Ambulance for govt help UI. */
export function termForGovEmergencyHelp(term: string): string {
  if (isAmbulanceEmergencySearch(term)) return "Ambulance";
  return term;
}

/** When radar is empty before max radius, show official lines alongside radius expand. */
export function showGovHelpAlongsideRadiusExpand(term: string): boolean {
  return govEmergencyHelpLinesForTerm(term) !== null;
}

/**
 * Category-keyed government helpline set for a search term.
 * Returns null when no official line is genuinely relevant (do not default to 112).
 */
export type GovEmergencyHelpKind = "fire" | "medical" | "roadside" | "security";

export function govEmergencyHelpLinesForTerm(term: string): GovEmergencyHelpKind | null {
  if (isAmbulanceEmergencySearch(term)) return "medical";
  const resolved = resolveCanonicalTerm(termForGovEmergencyHelp(term));
  if (!resolved) return null;
  if (FIRE_EMERGENCY_LABELS.has(resolved)) return "fire";
  if (MEDICAL_EMERGENCY_LABELS.has(resolved)) return "medical";
  if (ROADSIDE_EMERGENCY_LABELS.has(resolved)) return "roadside";
  if (resolved === "Security") return "security";
  return null;
}
