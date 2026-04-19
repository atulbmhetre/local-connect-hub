import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rpxsyeqskvhjmbkxnpmd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

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
  created_at: string;
};

export const CATEGORIES = [
  { id: "tyre", label: "Tyre / Mechanic", emoji: "🛞" },
  { id: "key", label: "Key Maker", emoji: "🔑" },
  { id: "medical", label: "Medical", emoji: "🩺" },
  { id: "electrician", label: "Electrician", emoji: "💡" },
] as const;

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
