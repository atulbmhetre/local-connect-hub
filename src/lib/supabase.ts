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
  | "business_verified"
  | "Green"
  | "Yellow"
  | "Red";

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
  last_updated?: string | null;
};

export const CATEGORIES = [
  { id: "mechanic", label: "Mechanic", emoji: "🔧" },
  { id: "towing", label: "Towing", emoji: "🚛" },
  { id: "tyre", label: "Tyre Service", emoji: "🛞" },
  { id: "key", label: "Key Maker", emoji: "🔑" },
  { id: "ambulance", label: "Ambulance", emoji: "🚑" },
  { id: "pharmacy", label: "Pharmacy", emoji: "💊" },
  { id: "nursing", label: "Nursing", emoji: "🩺" },
  { id: "plumber", label: "Plumber", emoji: "🚰" },
  { id: "electrician", label: "Electrician", emoji: "💡" },
  { id: "security", label: "Security", emoji: "🛡️" },
  { id: "other", label: "Other", emoji: "✨" },
] as const;

export const SHOP_PHOTOS_BUCKET = "shop-photos";
export const GPS_MATCH_TOLERANCE_M = 75;

type CategoryMode = "help" | "delivery";
export type CategoryClassification = {
  canonical: string;
  mode: CategoryMode;
  emoji: string;
  hindi: string;
};

// Local category aliases for fuzzy matching user-entered "Other" services.
const KNOWN_CATEGORIES: { label: string; aliases: string[] }[] = [
  {
    label: "Beautician",
    aliases: ["butisian", "beautician", "parlour", "parlor", "beauty", "salon"],
  },
  {
    label: "Kirana Store",
    aliases: ["kirana", "grocery", "general store", "dukan", "dukkan"],
  },
  {
    label: "Mechanic",
    aliases: ["mikanik", "mechanic", "garage", "repair", "engine", "car repair", "bike repair"],
  },
  { label: "Towing", aliases: ["towing", "tow", "tow truck", "breakdown", "crane"] },
  { label: "Tyre Service", aliases: ["tyre", "tire", "puncture", "flat tyre", "wheel"] },
  { label: "Key Maker", aliases: ["key", "keymaker", "locksmith", "duplicate key", "lock"] },
  { label: "Ambulance", aliases: ["ambulance", "emergency", "hospital", "108"] },
  {
    label: "Pharmacy",
    aliases: ["dawai", "dawa", "medicine", "pharmacy", "chemist", "medical", "drug store", "tablet"],
  },
  { label: "Nursing", aliases: ["nurse", "nursing", "caretaker", "home care", "patient care"] },
  { label: "Plumber", aliases: ["plumber", "pipe", "nal wala", "water", "plumbing", "leak", "tap"] },
  { label: "Electrician", aliases: ["bijli", "electrician", "light wala", "current wala", "electric", "wiring", "fuse", "power"] },
  { label: "Security", aliases: ["security", "guard", "watchman", "bouncer"] },
];

const HINDI_BY_CANONICAL: Record<string, string> = {
  Beautician: "ब्यूटीशियन",
  "Kirana Store": "किराना स्टोर",
  Mechanic: "मैकेनिक",
  Towing: "टोइंग",
  "Tyre Service": "टायर सर्विस",
  "Key Maker": "चाबी बनाने वाला",
  Ambulance: "एंबुलेंस",
  Pharmacy: "फार्मेसी",
  Nursing: "नर्सिंग",
  Plumber: "प्लम्बर",
  Electrician: "इलेक्ट्रीशियन",
  Security: "सिक्योरिटी",
  Other: "अन्य",
};

const MODE_BY_CANONICAL: Record<string, CategoryMode> = {
  Beautician: "help",
  "Kirana Store": "delivery",
  Pharmacy: "delivery",
};

function resolveKnownCategory(rawInput: string): string | null {
  const t = rawInput.toLowerCase().trim();
  for (const c of KNOWN_CATEGORIES) {
    if (c.label.toLowerCase() === t) return c.label;
    if (c.aliases.some((a) => t.includes(a))) return c.label;
  }
  return null;
}

function emojiForCanonical(canonical: string) {
  const cat = CATEGORIES.find((c) => c.label.toLowerCase() === canonical.toLowerCase());
  return cat?.emoji ?? "✨";
}

function defaultClassification(rawInput: string): CategoryClassification {
  const tryCanon = (canonical: string, mode: CategoryMode): CategoryClassification => ({
    canonical,
    mode,
    emoji: emojiForCanonical(canonical),
    hindi: HINDI_BY_CANONICAL[canonical] ?? "अन्य",
  });

  const resolved = resolveKnownCategory(rawInput);
  if (resolved) return tryCanon(resolved, MODE_BY_CANONICAL[resolved] ?? "help");

  return tryCanon("Other", "help");
}

export async function classifyCategory(rawInput: string): Promise<CategoryClassification> {
  const input = rawInput.trim();
  if (!input) return defaultClassification(rawInput);

  try {
    const resp = await fetch(
      "https://rpxsyeqskvhjmbkxnpmd.supabase.co/functions/v1/ai-gateway",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action: "classify_category",
          input,
        }),
      },
    );

    if (!resp.ok) return defaultClassification(rawInput);
    const data: any = await resp.json();
    const result = data?.result;
    if (!result || typeof result.canonical !== "string" || !result.canonical.trim()) {
      return defaultClassification(rawInput);
    }

    return {
      canonical: result.canonical.trim(),
      mode: result.mode === "delivery" ? "delivery" : "help",
      emoji: typeof result.emoji === "string" && result.emoji.trim() ? result.emoji.trim() : "✨",
      hindi: typeof result.hindi === "string" && result.hindi.trim() ? result.hindi.trim() : "अन्य",
    };
  } catch {
    return defaultClassification(rawInput);
  }
}

// Categories whose vendors physically move to the customer.
// Their GPS is refreshed every time they go "Ready to Help".
export const MOBILE_CATEGORIES = new Set<string>([
  "Mechanic",
  "Towing",
  "Tyre Service",
  "Key Maker",
  "Ambulance",
  "Nursing",
]);

export function isMobileCategory(category: string) {
  return MOBILE_CATEGORIES.has(category);
}

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
