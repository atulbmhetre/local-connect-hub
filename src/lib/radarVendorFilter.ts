import type { Vendor } from "@/lib/supabase";
import {
  normalizeServiceRadiusKm,
  PAN_INDIA_RADIUS_KM,
} from "@/lib/serviceRadius";

type VendorModeSlice = Pick<Vendor, "is_active" | "service_mode">;

/**
 * Safety net: on the Help radar tab, never surface offline vendors.
 * On delivery/appointment tabs, offline multi-mode vendors remain visible
 * (primary service_mode may be "help" while the tab mode is not).
 */
export function excludeOfflineHelpVendors<T extends VendorModeSlice>(
  vendors: T[],
  activeRadarMode?: string,
): T[] {
  const tabMode = String(activeRadarMode ?? "help").trim().toLowerCase();
  if (tabMode !== "help") return vendors;
  return vendors.filter((v) => v.is_active !== false);
}

/** Track A: vendor must be within min(user bracket, vendor service radius). Pan-India uses Track B. */
export function passesTrackARadiusFilter(
  distanceKm: number,
  userBracketKm: number,
  vendorServiceRadiusKm: number | null | undefined,
): boolean {
  const vendorMaxRadius = normalizeServiceRadiusKm(vendorServiceRadiusKm);
  if (vendorMaxRadius === PAN_INDIA_RADIUS_KM) return false;
  return distanceKm <= Math.min(userBracketKm, vendorMaxRadius);
}

export function isPanIndiaServiceRadius(
  vendorServiceRadiusKm: number | null | undefined,
): boolean {
  return normalizeServiceRadiusKm(vendorServiceRadiusKm) === PAN_INDIA_RADIUS_KM;
}

/** Merge Track A (local) and Track B (pan-India) results for the active search bracket. */
export function mergeRadarTracks<T>(trackA: T[], trackB: T[], panIndiaOnly: boolean): T[] {
  return panIndiaOnly ? trackB : [...trackA, ...trackB];
}
