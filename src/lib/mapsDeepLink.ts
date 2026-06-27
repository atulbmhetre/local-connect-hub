export type CustomerMapsFields = {
  customer_latitude?: number | null;
  customer_longitude?: number | null;
  delivery_address?: string | null;
  message?: string | null;
  status: string;
};

export type VendorMapsFields = {
  latitude?: number | null;
  longitude?: number | null;
};

const COME_TO_ME_MARKERS = ["[Come to my place]", "[मेरे घर आएं]", "[माझ्या घरी या]"];
const VISIT_SHOP_MARKERS = ["[I'll visit your shop]", "[मैं दुकान आऊंगा]", "[मी दुकानात येईन]"];

export function isOrderJobActiveForMaps(status: string): boolean {
  const normalized = status.toLowerCase();
  return (
    normalized !== "done" &&
    normalized !== "cancelled" &&
    normalized !== "fulfilled" &&
    normalized !== "completed" &&
    normalized !== "confirmed"
  );
}

export function isAppointmentAtCustomerHome(row: Pick<CustomerMapsFields, "message" | "delivery_address">): boolean {
  const msg = row.message ?? "";
  if (COME_TO_ME_MARKERS.some((marker) => msg.includes(marker))) return true;
  return !!row.delivery_address?.trim();
}

export function isAppointmentAtVendorShop(row: Pick<CustomerMapsFields, "message">): boolean {
  const msg = row.message ?? "";
  return VISIT_SHOP_MARKERS.some((marker) => msg.includes(marker));
}

export function buildCoordsMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

export function buildAddressMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function resolveCustomerMapsUrl(row: CustomerMapsFields): string | null {
  const lat = row.customer_latitude;
  const lng = row.customer_longitude;
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return buildCoordsMapsUrl(lat, lng);
  }
  const address = row.delivery_address?.trim();
  if (address) return buildAddressMapsUrl(address);
  return null;
}

export function resolveVendorNavigateToCustomerUrl(
  serviceMode: string | null | undefined,
  row: CustomerMapsFields,
): string | null {
  if (!isOrderJobActiveForMaps(row.status)) return null;

  const mode = String(serviceMode ?? "").trim().toLowerCase();
  if (mode === "appointment" && isAppointmentAtVendorShop(row)) return null;
  if (mode !== "delivery" && mode !== "help" && mode !== "appointment") return null;

  return resolveCustomerMapsUrl(row);
}

export function resolveCustomerNavigateToVendorUrl(
  row: CustomerMapsFields & {
    vendors?: (VendorMapsFields & { service_mode?: string | null }) | null;
  },
): string | null {
  if (!isOrderJobActiveForMaps(row.status)) return null;
  if (String(row.vendors?.service_mode ?? "").trim().toLowerCase() !== "appointment") return null;
  if (!isAppointmentAtVendorShop(row)) return null;

  const lat = row.vendors?.latitude;
  const lng = row.vendors?.longitude;
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
    return buildCoordsMapsUrl(lat, lng);
  }
  return null;
}

export function openGoogleMaps(url: string): void {
  window.open(url, "_blank");
}
