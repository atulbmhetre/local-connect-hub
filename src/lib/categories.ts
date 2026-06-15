export type CategoryServiceMode = "help" | "delivery" | "appointment";

export type KnownCategoryDef = {
  label: string;
  aliases: string[];
  service_mode: CategoryServiceMode;
  isEmergency: boolean;
};

/** Unified alias map — single source for Home search, Radar, and classification. */
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
    aliases: ["mikanik", "mechanic", "garage", "repair", "engine", "car repair", "bike repair"],
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
    service_mode: "help",
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

const KNOWN_CATEGORY_LIST = Object.values(KNOWN_CATEGORIES);

const OFFICIAL_EMERGENCY_LABELS = new Set(
  KNOWN_CATEGORY_LIST.filter((c) => c.isEmergency).map((c) => c.label),
);

export const MEDICAL_EMERGENCY_LABELS = new Set(["Ambulance", "Pharmacy", "Nursing"]);
export const ROADSIDE_EMERGENCY_LABELS = new Set(["Mechanic", "Towing", "Tyre Service"]);
export const FIRE_EMERGENCY_LABELS = new Set(["Fire Brigade"]);

const PHARMACY_MEDICAL_RAW = /\b(medical|medicine|dawai|dawa|pharmacy|chemist|tablet)\b/;

/** Map free-text / voice input to a canonical category label, or null if no match. */
export function resolveCanonicalTerm(rawInput: string): string | null {
  const t = rawInput.toLowerCase().trim();
  for (const c of KNOWN_CATEGORY_LIST) {
    if (c.label.toLowerCase() === t) return c.label;
    if (c.aliases.some((a) => t.includes(a))) return c.label;
  }
  return null;
}

/**
 * Ambulance / accident / hospital / standalone "emergency" — 108 gov UI only, no vendor search.
 * Distinct from pharmacy/medical searches which show vendors + 104 helpline hint.
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
  if (isAmbulanceEmergencySearch(term)) return true;
  const r = resolveCanonicalTerm(term);
  if (!r) return false;
  return r === "Fire Brigade" || r === "Nursing";
}
