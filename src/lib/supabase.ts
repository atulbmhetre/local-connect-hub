import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rpxsyeqskvhjmbkxnpmd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

const AI_GATEWAY_URL = `${SUPABASE_URL}/functions/v1/ai-gateway`;

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
  /** Hyperlocal service vs delivery; drives reputation copy on cards. */
  service_mode?: "help" | "delivery" | "appointment";
  vendor_note?: string | null;
  total_helped?: number;
  total_delivered?: number;
  /** 0–100, delivery on-time rate */
  on_time_rate?: number;
};

export type RequestRow = {
  id: string;
  device_id: string;
  vendor_id: string;
  message: string;
  status: string;
  created_at: string;
  user_phone: string | null;
  device_id_log: string | null;
  delivery_address: string | null;
  appointment_time: string | null;
  appointment_status: string | null;
};

export type Category = {
  id: string;
  label: string;
  emoji: string;
  service_mode: "help" | "delivery" | "appointment";
  is_active: boolean;
  sort_order: number;
};

export type CategoryGroup = {
  service_mode: "help" | "delivery" | "appointment";
  label: string;
  categories: Category[];
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
  { id: "fire-brigade", label: "Fire Brigade", emoji: "🔥" },
  { id: "tailor", label: "Tailor", emoji: "🧵" },
  { id: "beautician", label: "Beautician", emoji: "💄" },
  { id: "cook", label: "Cook", emoji: "👨‍🍳" },
  { id: "barber", label: "Barber", emoji: "💈" },
  { id: "therapist", label: "Therapist", emoji: "🧘" },
  { id: "other", label: "Other", emoji: "✨" },
] as const;

export const DISPLAY_NAME: Record<string, string> = {
  "Tyre Service": "Tyre / Puncture",
};

export function displayName(canonical: string): string {
  return DISPLAY_NAME[canonical] ?? canonical;
}

export const SHOP_PHOTOS_BUCKET = "shop-photos";
export const GPS_MATCH_TOLERANCE_M = 75;

type CategoryMode = "help" | "delivery";
export type CategoryClassification = {
  /** Null when the classifier returns a hint instead of a vendor category (e.g. hospital). */
  canonical: string | null;
  mode: CategoryMode;
  emoji: string;
  hindi: string;
  message?: string;
  is_government?: boolean;
};

// Local category aliases for fuzzy matching user-entered "Other" services.
const KNOWN_CATEGORIES: { label: string; aliases: string[] }[] = [
  {
    label: "Beautician",
    aliases: [
      "butisian",
      "beautician",
      "parlour",
      "parlor",
      "beauty",
      "salon",
      "therapist",
      "therapy",
      "massage",
      "spa",
      "beauty parlour",
      "mehendi",
      "makeup artist",
      "nail art",
      "facial",
      "waxing",
    ],
  },
  {
    label: "Grocery Store",
    aliases: ["kirana", "grocery", "general store", "dukan", "dukkan"],
  },
  {
    label: "Mechanic",
    aliases: ["mikanik", "mechanic", "garage", "repair", "engine", "car repair", "bike repair"],
  },
  { label: "Towing", aliases: ["towing", "tow", "tow truck", "breakdown", "crane"] },
  { label: "Tyre Service", aliases: ["tyre", "tire", "puncture", "flat tyre", "wheel"] },
  { label: "Key Maker", aliases: ["key", "keymaker", "locksmith", "duplicate key", "lock"] },
  { label: "Ambulance", aliases: ["ambulance", "emergency", "108"] },
  {
    label: "Pharmacy",
    aliases: ["dawai", "dawa", "medicine", "pharmacy", "chemist", "medical", "drug store", "tablet"],
  },
  { label: "Nursing", aliases: ["nurse", "nursing", "caretaker", "home care", "patient care"] },
  { label: "Plumber", aliases: ["plumber", "pipe", "nal wala", "water", "plumbing", "leak", "tap"] },
  { label: "Electrician", aliases: ["bijli", "electrician", "light wala", "current wala", "electric", "wiring", "fuse", "power"] },
  { label: "Security", aliases: ["security", "guard", "watchman", "bouncer"] },
  {
    label: "Fire Brigade",
    aliases: ["fire station", "fire brigade", "agni shaman", "agnishaman", "fire emergency"],
  },
];

const HINDI_BY_CANONICAL: Record<string, string> = {
  Beautician: "ब्यूटीशियन",
  "Grocery Store": "किराना स्टोर",
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
  "Fire Brigade": "फायर ब्रिगेड",
  Other: "अन्य",
};

const MODE_BY_CANONICAL: Record<string, CategoryMode> = {
  Beautician: "help",
  "Grocery Store": "delivery",
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

/** Resolved canonical label → full classification (vendor picker + edge fallback). */
function classificationFromCanonical(canonical: string): CategoryClassification {
  return {
    canonical,
    mode: MODE_BY_CANONICAL[canonical] ?? "help",
    emoji: emojiForCanonical(canonical),
    hindi: HINDI_BY_CANONICAL[canonical] ?? "अन्य",
  };
}

function defaultClassification(rawInput: string): CategoryClassification {
  const resolved = resolveKnownCategory(rawInput);
  if (resolved) return classificationFromCanonical(resolved);

  return classificationFromCanonical("Other");
}

export async function classifyCategory(rawInput: string): Promise<CategoryClassification> {
  const input = rawInput.trim();
  if (!input) return defaultClassification(rawInput);

  const localMatch = resolveKnownCategory(rawInput);
  if (localMatch) return classificationFromCanonical(localMatch);

  try {
    const resp = await fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "classify_category",
        term: input,
        input,
      }),
    });

    if (!resp.ok) return defaultClassification(rawInput);
    const data: any = await resp.json();
    const result = data?.result;
    if (!result) return defaultClassification(rawInput);

    if (result.canonical === null && typeof result.message === "string" && result.message.trim()) {
      return {
        canonical: null,
        mode: "help",
        emoji: "ℹ️",
        hindi: "",
        message: result.message.trim(),
      };
    }

    if (typeof result.canonical !== "string" || !result.canonical.trim()) {
      return defaultClassification(rawInput);
    }

    return {
      canonical: result.canonical.trim(),
      mode: result.mode === "delivery" ? "delivery" : "help",
      emoji: typeof result.emoji === "string" && result.emoji.trim() ? result.emoji.trim() : "✨",
      hindi: typeof result.hindi === "string" && result.hindi.trim() ? result.hindi.trim() : "अन्य",
      is_government: result.is_government === true,
    };
  } catch {
    return defaultClassification(rawInput);
  }
}

/** Home search bar: classify free text with 5s timeout; fallback = original term. */
export type ClassifySearchForRadarResult =
  | { outcome: "canonical"; query: string }
  | { outcome: "hint"; message: string }
  | { outcome: "fallback"; query: string };

export async function classifySearchTermForRadar(
  rawInput: string,
): Promise<ClassifySearchForRadarResult> {
  const term = rawInput.trim();
  if (!term) return { outcome: "fallback", query: "" };

  const localCanon = resolveKnownCategory(rawInput);
  if (localCanon) return { outcome: "canonical", query: localCanon };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5_000);
    const resp = await fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "classify_category",
        term,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) return { outcome: "fallback", query: term };

    const data: unknown = await resp.json();
    const result =
      data && typeof data === "object" && "result" in data
        ? (data as { result: Record<string, unknown> }).result
        : null;
    if (!result) return { outcome: "fallback", query: term };

    if (
      result.canonical === null &&
      typeof result.message === "string" &&
      result.message.trim()
    ) {
      return { outcome: "hint", message: result.message.trim() };
    }

    if (typeof result.canonical === "string" && result.canonical.trim()) {
      return { outcome: "canonical", query: result.canonical.trim() };
    }

    return { outcome: "fallback", query: term };
  } catch {
    return { outcome: "fallback", query: term };
  }
}

export type AiBridgeBriefResult =
  | { ok: true; brief: string }
  | { ok: false; error: string };

/** Calls deployed `ai-gateway` Edge Function (action `ai_bridge_brief`). */
export async function fetchAiBridgeBrief(payload: {
  vendor_name: string;
  shop_name: string;
  category: string;
  distance_km: number | null;
  user_need: string;
}): Promise<AiBridgeBriefResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 14_000);
    const resp = await fetch(AI_GATEWAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        action: "ai_bridge_brief",
        vendor_name: payload.vendor_name,
        shop_name: payload.shop_name,
        category: payload.category,
        distance_km: payload.distance_km,
        user_need: payload.user_need,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const t = await resp.text();
      return { ok: false, error: t || `HTTP ${resp.status}` };
    }

    const data: unknown = await resp.json();
    const brief =
      data &&
      typeof data === "object" &&
      "result" in data &&
      data.result &&
      typeof (data as { result: { brief?: unknown } }).result.brief === "string"
        ? (data as { result: { brief: string } }).result.brief.trim()
        : "";

    if (!brief) return { ok: false, error: "Empty brief" };
    return { ok: true, brief };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Network error";
    return { ok: false, error: msg };
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

export async function fetchCategories(): Promise<Category[]> {
  const [catResult, vendorResult] = await Promise.all([
    supabase
      .from("categories")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabase.from("vendors").select("category").eq("is_active", true),
  ]);

  if (catResult.error || !catResult.data) return [];

  const activeVendorCategories = new Set((vendorResult.data ?? []).map((v) => v.category));

  return (catResult.data as Category[]).filter((c) => activeVendorCategories.has(c.label));
}

export function groupCategoriesByMode(categories: Category[]): CategoryGroup[] {
  const MODE_LABELS: Record<string, string> = {
    help: "🚨 Emergency & Help",
    delivery: "🛒 Delivery",
    appointment: "✂️ Book a Service",
  };
  const order = ["help", "delivery", "appointment"];
  const grouped: Record<string, Category[]> = { help: [], delivery: [], appointment: [] };
  for (const cat of categories) {
    if (grouped[cat.service_mode]) grouped[cat.service_mode].push(cat);
  }
  return order
    .filter((mode) => grouped[mode].length > 0)
    .map((mode) => ({
      service_mode: mode as "help" | "delivery" | "appointment",
      label: MODE_LABELS[mode],
      categories: grouped[mode],
    }));
}

export function emojiForCategory(label: string, categories: Category[]): string {
  return categories.find((c) => c.label.toLowerCase() === label.toLowerCase())?.emoji ?? "✨";
}

/** Emoji for vendor.category (Quick Assist / radar labels). */
export function emojiForVendorCategory(category: string, categories?: Category[]): string {
  if (categories?.length) return emojiForCategory(category, categories);
  const c = CATEGORIES.find((x) => x.label.toLowerCase() === category.trim().toLowerCase());
  return c?.emoji ?? "✨";
}
