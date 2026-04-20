import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rpxsyeqskvhjmbkxnpmd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

export type VerificationStatus =
  | "unverified"
  | "identity_linked"
  | "business_verified";

export type Vendor = {
  id: string;
  name: string;
  shop_name: string;
  category: string;
  upi_id: string;
  phone: string;
  is_active: boolean;
  latitude: number | null;
  longitude: number | null;
  verification_status: VerificationStatus;
  shop_photo_url: string | null;
  upi_verified: boolean;
  is_manual_verified: boolean;
  created_at: string;
};

export const CATEGORIES = [
  { id: "tyre", label: "Tyre / Mechanic", emoji: "🛞" },
  { id: "key", label: "Key Maker", emoji: "🔑" },
  { id: "medical", label: "Medical", emoji: "🩺" },
  { id: "electrician", label: "Electrician", emoji: "💡" },
] as const;

export const SHOP_PHOTOS_BUCKET = "shop-photos";
export const GPS_MATCH_TOLERANCE_M = 100;

export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  return distanceKm(a, b) * 1000;
}

// Lightweight UPI format check: handle@provider, handle 2-256 chars total.
const UPI_RE = /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/;
export function isValidUpi(upi: string) {
  return UPI_RE.test(upi.trim());
}

// Indian phone heuristic: optional +91, 10 digits starting 6-9.
const PHONE_RE = /^(\+?91[\s-]?)?[6-9]\d{9}$/;
export function isValidPhone(phone: string) {
  return PHONE_RE.test(phone.replace(/\s|-/g, ""));
}

/**
 * Whether a vendor has met every prerequisite for the Green badge.
 * Manual admin approval (`is_manual_verified`) gates the actual glow.
 */
export function meetsGreenCriteria(v: Vendor) {
  return (
    !!v.shop_photo_url &&
    v.upi_verified &&
    isValidPhone(v.phone ?? "") &&
    v.verification_status === "business_verified"
  );
}

export function isGreenLive(v: Vendor) {
  return meetsGreenCriteria(v) && v.is_manual_verified;
}
