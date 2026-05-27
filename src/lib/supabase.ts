import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://rpxsyeqskvhjmbkxnpmd.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJweHN5ZXFza3Zoam1ia3hucG1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0ODQ3MDEsImV4cCI6MjA5MjA2MDcwMX0.HXZF2uGxkUbBrYMWfvOQyx8_7Syrx4BY3pdt0z1dNF0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 5 } },
});

const AI_GATEWAY_URL = `${SUPABASE_URL}/functions/v1/ai-gateway`;
export const NOTIFY_VENDOR_URL = `${SUPABASE_URL}/functions/v1/notify-vendor`;
export const NOTIFY_USER_URL = `${SUPABASE_URL}/functions/v1/notify-user`;
export const INITIATE_CALL_URL = `${SUPABASE_URL}/functions/v1/initiate-call`;

export async function invokeInitiateCall(body: {
  caller_phone: string;
  vendor_phone: string;
  service_mode: string;
}): Promise<{ success: boolean; call_sid?: string; error?: string }> {
  try {
    const resp = await fetch(INITIATE_CALL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as {
      success?: boolean;
      call_sid?: string;
      error?: string;
    };
    if (!resp.ok || !data.success) {
      const result = {
        success: false as const,
        error: data.error ?? `HTTP ${resp.status}`,
        status: resp.status,
        data,
      };
      console.log("Exotel response:", result);
      return { success: false, error: result.error };
    }
    return { success: true, call_sid: data.call_sid };
  } catch (err) {
    const result = {
      success: false as const,
      error: err instanceof Error ? err.message : "Network error",
    };
    console.log("Exotel response:", result);
    return result;
  }
}

export async function upsertUser(phone: string): Promise<void> {
  try {
    const { error } = await supabase.from("users").upsert(
      { phone, last_active: new Date().toISOString() },
      { onConflict: "phone" },
    );
    if (error) console.error("upsertUser", error);
  } catch (err) {
    console.error("upsertUser", err);
  }
}

export async function incrementUserOrders(phone: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("increment_user_orders", {
      user_phone: phone,
    });
    if (error) console.error("incrementUserOrders", error);
  } catch (err) {
    console.error("incrementUserOrders", err);
  }
}

export async function fetchUserTrust(phone: string): Promise<{
  trust_score: number;
  total_orders: number;
  is_banned: boolean;
  ban_reason: string | null;
} | null> {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("trust_score, total_orders, is_banned, ban_reason")
      .eq("phone", phone)
      .maybeSingle();
    if (error) {
      console.error("fetchUserTrust", error);
      return null;
    }
    return data;
  } catch (err) {
    console.error("fetchUserTrust", err);
    return null;
  }
}

export async function invokecalculateTrustScore(
  userPhone: string,
): Promise<{ success?: boolean; trust_score?: number } | null> {
  try {
    const { data, error } = await supabase.functions.invoke("calculate-trust-score", {
      body: { user_phone: userPhone },
    });
    if (error) {
      console.error("invokecalculateTrustScore", error);
      return null;
    }
    return data ?? null;
  } catch (err) {
    console.error("invokecalculateTrustScore", err);
    return null;
  }
}

/** Best-effort push to vendor; never throws. */
export async function invokeNotifyVendor(record: {
  vendor_id: string;
  category?: string;
  message?: string;
  notification_title?: string;
}): Promise<void> {
  try {
    await fetch(NOTIFY_VENDOR_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ record }),
    });
  } catch {
    /* ignore */
  }
}

/** Best-effort push to user devices; never throws. */
export async function invokeNotifyUser(payload: {
  user_phone: string;
  title: string;
  body: string;
}): Promise<void> {
  try {
    await fetch(NOTIFY_USER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    /* ignore */
  }
}

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
  subscription_active?: boolean;
  last_updated?: string | null;
  /** Hyperlocal service vs delivery; drives reputation copy on cards. */
  service_mode?: "help" | "delivery" | "appointment";
  vendor_note?: string | null;
  cancel_reason_1: string | null;
  cancel_reason_2: string | null;
  cancel_reason_3: string | null;
  cancel_reason_4: string | null;
  total_helped?: number;
  total_delivered?: number;
  /** 0–100, delivery on-time rate */
  on_time_rate?: number;
  avg_rating?: number | null;
  review_count?: number | null;
};

export type RequestRow = {
  id: string;
  device_id: string;
  vendor_id: string;
  message: string;
  status: "sent" | "seen" | "accepted" | "fulfilled" | "done" | "cancelled";
  created_at: string;
  user_phone: string | null;
  device_id_log: string | null;
  delivery_address: string | null;
  delivery_slot: string | null;
  appointment_time: string | null;
  appointment_status: "pending" | "confirmed" | "declined" | "cancelled" | null;
  cancel_reason: string | null;
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

async function serviceModeForCanonical(canonical: string): Promise<CategoryMode> {
  const { data: catData } = await supabase
    .from("categories")
    .select("service_mode")
    .ilike("label", canonical)
    .eq("is_active", true)
    .single();

  const mode = catData?.service_mode;
  if (mode === "delivery" || mode === "help" || mode === "appointment") {
    return mode;
  }
  return "help";
}

/** Resolved canonical label → full classification (vendor picker + edge fallback). */
async function classificationFromCanonical(
  canonical: string,
): Promise<CategoryClassification> {
  const mode = await serviceModeForCanonical(canonical);
  return {
    canonical,
    mode,
    emoji: emojiForCanonical(canonical),
    hindi: HINDI_BY_CANONICAL[canonical] ?? "अन्य",
  };
}

async function defaultClassification(
  rawInput: string,
): Promise<CategoryClassification> {
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

    const canonical = result.canonical.trim();
    const mode = await serviceModeForCanonical(canonical);

    return {
      canonical,
      mode,
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
  if (localCanon) {
    await serviceModeForCanonical(localCanon);
    return { outcome: "canonical", query: localCanon };
  }

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
      const canonical = result.canonical.trim();
      await serviceModeForCanonical(canonical);
      return { outcome: "canonical", query: canonical };
    }

    return { outcome: "fallback", query: term };
  } catch {
    return { outcome: "fallback", query: term };
  }
}

export type AiBridgeBriefResult =
  | { ok: true; brief: string }
  | { ok: false; error: string };

export async function fetchAiBridgeBrief(payload: {
  vendor_name: string;
  shop_name: string;
  category: string;
  distance_km: number | null;
  user_need: string;
}): Promise<AiBridgeBriefResult> {
  try {
    const distance = payload.distance_km != null
      ? `${payload.distance_km.toFixed(1)} km away`
      : "nearby";

    const brief = `${payload.shop_name} (${payload.category}) is ${distance}. Customer needs: ${payload.user_need.slice(0, 100)}`;

    return { ok: true, brief };
  } catch (e) {
    return { ok: false, error: "Could not generate brief" };
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

export function groupCategoriesByMode(
  categories: Category[],
  labels?: { help: string; delivery: string; appointment: string },
): CategoryGroup[] {
  const MODE_LABELS: Record<string, string> = labels ?? {
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

// Category translation helper
// Usage: const getLabel = useCategoryLabel();
//        getLabel(vendor.category) → translated label in active language

import { useLanguage } from "@/lib/language";
import { useEffect, useState } from "react";

type TranslationMap = Record<string, string>; // category English label → translated label

export function useCategoryLabel() {
  const { lang } = useLanguage();
  const [map, setMap] = useState<TranslationMap>({});

  useEffect(() => {
    supabase
      .from("category_translations")
      .select("lang, label, categories(label)")
      .eq("lang", lang)
      .then(({ data }) => {
        if (!data) return;
        const m: TranslationMap = {};
        data.forEach((row: any) => {
          const original = row.categories?.label;
          if (original) m[original] = row.label;
        });
        setMap(m);
      });
  }, [lang]);

  // Falls back to original English label if translation missing
  return (englishLabel: string) => map[englishLabel] ?? englishLabel;
}

// service_mode translation — fixed enum, never changes
export function useServiceModeLabel() {
  const { lang } = useLanguage();
  const map: Record<string, Record<string, string>> = {
    en: { help: "Help", delivery: "Delivery", appointment: "Appointment" },
    hi: { help: "मदद", delivery: "डिलीवरी", appointment: "अपॉइंटमेंट" },
    mr: { help: "मदत", delivery: "डिलिव्हरी", appointment: "अपॉइंटमेंट" },
  };
  return (mode: string) => map[lang]?.[mode] ?? mode;
}
