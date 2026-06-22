export const SERVICE_RADIUS_OPTIONS = [5, 15, 25, 50, 100, 500, 9999] as const;

export type ServiceRadiusKm = (typeof SERVICE_RADIUS_OPTIONS)[number];

export const DEFAULT_SERVICE_RADIUS_KM = 15;

export const PAN_INDIA_RADIUS_KM = 9999;

export function normalizeServiceRadiusKm(value: number | null | undefined): number {
  if (value == null) return DEFAULT_SERVICE_RADIUS_KM;
  if ((SERVICE_RADIUS_OPTIONS as readonly number[]).includes(value)) return value;
  return DEFAULT_SERVICE_RADIUS_KM;
}
