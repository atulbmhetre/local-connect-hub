import { getDeviceId } from "@/lib/deviceId";

/** Floor for shop-photo GPS match (meters). Effective tolerance may be higher. */
export const GPS_MATCH_TOLERANCE_M = 75;

/** Same-shop / co-located business detection (meters). Matches server RPC. */
export const SAME_SHOP_TOLERANCE_M = GPS_MATCH_TOLERANCE_M;

/** After this many failed match attempts, show "Submit for review anyway". */
export const GPS_MATCH_FAILS_BEFORE_SOFT_REVIEW = 2;

export type GpsPoint = {
  lat: number;
  lng: number;
  /** Device-reported horizontal accuracy in meters, when available. */
  accuracy?: number | null;
};

export type GpsMatchEvaluation = {
  distanceMeters: number;
  locationAccuracy: number | null;
  photoAccuracy: number | null;
  effectiveTolerance: number;
  ok: boolean;
};

function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function normalizeGpsAccuracy(meters: number | null | undefined): number {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return 0;
  return meters;
}

/**
 * Accuracy-aware tolerance: floor of GPS_MATCH_TOLERANCE_M, else
 * locationAccuracy + photoAccuracy when that sum is larger.
 */
export function gpsEffectiveTolerance(
  locationAccuracy: number | null | undefined,
  photoAccuracy: number | null | undefined,
): number {
  return Math.max(
    GPS_MATCH_TOLERANCE_M,
    normalizeGpsAccuracy(locationAccuracy) + normalizeGpsAccuracy(photoAccuracy),
  );
}

export function evaluateGpsMatch(shop: GpsPoint, photo: GpsPoint): GpsMatchEvaluation {
  const distanceMeters = haversineMeters(shop, photo);
  const locationAccuracy =
    shop.accuracy != null && Number.isFinite(shop.accuracy) ? shop.accuracy : null;
  const photoAccuracy =
    photo.accuracy != null && Number.isFinite(photo.accuracy) ? photo.accuracy : null;
  const effectiveTolerance = gpsEffectiveTolerance(locationAccuracy, photoAccuracy);
  return {
    distanceMeters,
    locationAccuracy,
    photoAccuracy,
    effectiveTolerance,
    ok: distanceMeters <= effectiveTolerance,
  };
}

export function readGeolocationAccuracy(coords: GeolocationCoordinates): number | null {
  const a = coords.accuracy;
  if (a == null || !Number.isFinite(a) || a < 0) return null;
  return a;
}

export type GpsMatchFailureSource = "registration" | "add_business" | "my_business";

export async function logGpsMatchFailure(params: {
  distanceMeters: number;
  locationAccuracy: number | null;
  photoAccuracy: number | null;
  effectiveTolerance: number;
  source: GpsMatchFailureSource;
  vendorId?: string | null;
  sessionKey?: string | null;
}): Promise<void> {
  try {
    // Lazy import avoids circular dependency with supabase.ts re-exports.
    const { supabase } = await import("@/lib/supabase");
    const { error } = await supabase.rpc("log_gps_match_failure", {
      p_distance_meters: params.distanceMeters,
      p_location_accuracy: params.locationAccuracy,
      p_photo_accuracy: params.photoAccuracy,
      p_effective_tolerance: params.effectiveTolerance,
      p_source: params.source,
      p_vendor_id: params.vendorId ?? null,
      p_device_id: getDeviceId(),
      p_session_key: params.sessionKey ?? null,
    });
    if (error) console.warn("log_gps_match_failure", error);
  } catch (err) {
    console.warn("log_gps_match_failure failed", err);
  }
}
