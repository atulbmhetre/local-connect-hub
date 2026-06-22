import { supabase } from "@/lib/supabase";

export type RecommendedVendorRadarLink =
  | { ok: true; categoryLabel: string }
  | { ok: false; offline: boolean };

export function buildRecommendedVendorRadarUrl(
  categoryLabel: string,
  serviceMode: string,
): string {
  const mode = serviceMode.trim() || "help";
  return `/radar?q=${encodeURIComponent(categoryLabel)}&mode=${encodeURIComponent(mode)}`;
}

export async function resolveRecommendedVendorRadarLink(
  vendorId: string,
  serviceMode: string | null | undefined,
): Promise<RecommendedVendorRadarLink> {
  const { data: vendor, error } = await supabase
    .from("vendors")
    .select("is_active, category")
    .eq("id", vendorId)
    .single();

  if (error || !vendor) {
    return { ok: false, offline: false };
  }

  const mode = String(serviceMode ?? "help").trim().toLowerCase();
  if (!vendor.is_active && mode === "help") {
    return { ok: false, offline: true };
  }

  let categoryLabel = String(vendor.category ?? "").trim();
  if (!categoryLabel) {
    const { data: vcRows } = await supabase
      .from("vendor_categories")
      .select("is_primary, categories(label)")
      .eq("vendor_id", vendorId)
      .eq("status", "approved");

    const rows = vcRows ?? [];
    const primary = rows.find((row) => row.is_primary === true) ?? rows[0];
    const cat = primary?.categories;
    const resolved = Array.isArray(cat) ? cat[0] : cat;
    categoryLabel = String((resolved as { label?: string } | null)?.label ?? "").trim();
  }

  if (!categoryLabel) {
    return { ok: false, offline: false };
  }

  return { ok: true, categoryLabel };
}
