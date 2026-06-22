import type { Vendor } from "@/lib/supabase";
import {
  normalizeServiceRadiusKm,
  PAN_INDIA_RADIUS_KM,
} from "@/lib/serviceRadius";

type VendorModeSlice = Pick<Vendor, "is_active" | "service_mode">;

/** Safety net: never surface offline help vendors even if query regresses. */
export function excludeOfflineHelpVendors<T extends VendorModeSlice>(vendors: T[]): T[] {
  return vendors.filter(
    (v) =>
      !(
        v.is_active === false &&
        String(v.service_mode ?? "").trim().toLowerCase() === "help"
      ),
  );
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
