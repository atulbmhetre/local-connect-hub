export const LICENSE_FIELD_CATEGORIES_KEY = "license_field_categories";

export type LicenseType =
  | "fssai"
  | "drug_license"
  | "medical_registration"
  | "shop_establishment"
  | "trade_license";

export type LicenseFieldCategoryMap = Record<string, LicenseType[]>;

/** Seeded on TEST via app_config.license_field_categories. Keys are catalog labels. */
export const DEFAULT_LICENSE_FIELD_CATEGORIES: LicenseFieldCategoryMap = {
  Pharmacy: ["drug_license"],
  Chemist: ["drug_license"],
  Grocery: ["fssai"],
  Kirana: ["fssai"],
  Restaurant: ["fssai"],
  Dhaba: ["fssai"],
  Clinic: ["medical_registration"],
  Doctor: ["medical_registration"],
  Hospital: ["medical_registration"],
  Salon: ["shop_establishment"],
  "Beauty Parlour": ["shop_establishment"],
};

const LICENSE_TYPES = new Set<LicenseType>([
  "fssai",
  "drug_license",
  "medical_registration",
  "shop_establishment",
  "trade_license",
]);

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function asLicenseType(value: string): LicenseType | null {
  const v = value.trim().toLowerCase() as LicenseType;
  return LICENSE_TYPES.has(v) ? v : null;
}

export function parseLicenseFieldCategories(raw: string | null | undefined): LicenseFieldCategoryMap {
  if (!raw || !String(raw).trim()) return { ...DEFAULT_LICENSE_FIELD_CATEGORIES };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...DEFAULT_LICENSE_FIELD_CATEGORIES };
    }
    const out: LicenseFieldCategoryMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.trim()) continue;
      const types = Array.isArray(value)
        ? value
            .map((item) => (typeof item === "string" ? asLicenseType(item) : null))
            .filter((item): item is LicenseType => item != null)
        : [];
      if (types.length) out[key] = types;
    }
    return Object.keys(out).length ? out : { ...DEFAULT_LICENSE_FIELD_CATEGORIES };
  } catch {
    return { ...DEFAULT_LICENSE_FIELD_CATEGORIES };
  }
}

export const GENERIC_LICENSE_TYPE = "generic";
export const SHOP_ESTABLISHMENT_LICENSE_TYPE = "shop_establishment";
export const LICENSE_REVIEW_APPROVED = "approved";

export type ApplicableLicenseField = {
  categoryId: string;
  categoryLabel: string;
  licenseType: string;
  fieldKey: string;
  displayName?: string;
};

export type CategoryLicenseRow = {
  id: string;
  label: string;
  license_type?: string | null;
  license_review_status?: string | null;
  license_confidence_score?: number | null;
};

function titleCaseLicense(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word.length === 0 ? "" : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    )
    .join(" ");
}

function licenseNormKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Canonical display name stored on categories.license_type. Shop & Establishment is never AI-classified. */
export function normalizeProposedLicenseType(raw: unknown): string {
  const t = String(raw ?? "").trim();
  if (!t) return GENERIC_LICENSE_TYPE;
  const n = licenseNormKey(t);
  if (
    n === "generic" ||
    n === "none" ||
    n === "n a" ||
    n === "na" ||
    n === "null" ||
    n === "no license" ||
    (n.includes("shop") && n.includes("establish"))
  ) {
    return GENERIC_LICENSE_TYPE;
  }
  if (n.includes("fssai") || n === "food license") return "FSSAI License";
  if (n.includes("drug") || n.includes("form 20") || n.includes("form 21")) return "Drug License";
  if (n.includes("medical") || n.includes("nmc") || n === "mci") return "Medical Registration";
  if (n.includes("trade license") || n === "trade") return "Trade License";
  if (n.includes("gst")) return "GST Registration";
  return titleCaseLicense(t);
}

/** Below threshold, a specific AI license is stored as generic (same 0.85 gate as high vs medium). */
export function applyLicenseConfidenceGate(
  type: string,
  confidence: number,
  threshold: number,
): string {
  if (type === GENERIC_LICENSE_TYPE) return GENERIC_LICENSE_TYPE;
  if (Number.isFinite(confidence) && confidence >= threshold) return type;
  return GENERIC_LICENSE_TYPE;
}

export function isGenericLicenseType(type: string | null | undefined): boolean {
  return !type || normalizeProposedLicenseType(type) === GENERIC_LICENSE_TYPE;
}

export function licenseTypeToSlug(type: string): string {
  const canonical = normalizeProposedLicenseType(type);
  if (canonical === GENERIC_LICENSE_TYPE) return GENERIC_LICENSE_TYPE;
  if (canonical === "FSSAI License") return "fssai";
  if (canonical === "Drug License") return "drug_license";
  if (canonical === "Medical Registration") return "medical_registration";
  if (canonical === "Trade License") return "trade_license";
  if (canonical === "GST Registration") return "gst";
  return licenseNormKey(canonical).replace(/\s+/g, "_");
}

export function approvedSpecificLicenseType(row: {
  license_type?: string | null;
  license_review_status?: string | null;
}): string | null {
  if (row.license_review_status !== LICENSE_REVIEW_APPROVED) return null;
  const type = normalizeProposedLicenseType(row.license_type);
  if (type === GENERIC_LICENSE_TYPE) return null;
  return type;
}

/** Wizard / Add Business fields: only approved, non-generic category licenses. */
export function wizardLicenseFields(
  categories: CategoryLicenseRow[],
): ApplicableLicenseField[] {
  const fields: ApplicableLicenseField[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    const specific = approvedSpecificLicenseType(cat);
    if (!specific) continue;
    const slug = licenseTypeToSlug(specific);
    if (slug === GENERIC_LICENSE_TYPE) continue;
    const fieldKey = `${cat.id}:${slug}`;
    if (seen.has(fieldKey)) continue;
    seen.add(fieldKey);
    fields.push({
      categoryId: cat.id,
      categoryLabel: cat.label,
      licenseType: slug,
      displayName: specific,
      fieldKey,
    });
  }
  return fields;
}

export function licenseTypesForCategoryLabel(
  label: string,
  mapping: LicenseFieldCategoryMap,
): LicenseType[] {
  const needle = normalizeLabel(label);
  if (!needle) return [];
  const seen = new Set<LicenseType>();
  const out: LicenseType[] = [];
  for (const [key, types] of Object.entries(mapping)) {
    const hay = normalizeLabel(key);
    if (!hay) continue;
    if (needle === hay || needle.includes(hay) || hay.includes(needle)) {
      for (const t of types) {
        if (!seen.has(t)) {
          seen.add(t);
          out.push(t);
        }
      }
    }
  }
  return out;
}

export function applicableLicenseFields(
  categories: Array<{ id: string; label: string }>,
  mapping: LicenseFieldCategoryMap,
): ApplicableLicenseField[] {
  const fields: ApplicableLicenseField[] = [];
  const seen = new Set<string>();
  for (const cat of categories) {
    for (const licenseType of licenseTypesForCategoryLabel(cat.label, mapping)) {
      const fieldKey = `${cat.id}:${licenseType}`;
      if (seen.has(fieldKey)) continue;
      seen.add(fieldKey);
      fields.push({
        categoryId: cat.id,
        categoryLabel: cat.label,
        licenseType,
        fieldKey,
      });
    }
  }
  return fields;
}

export function licenseFieldHasValue(entry: {
  license_number?: string | null;
  photo_url?: string | null;
}): boolean {
  return Boolean(String(entry.license_number ?? "").trim() || String(entry.photo_url ?? "").trim());
}
