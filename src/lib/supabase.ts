import { createClient } from "@supabase/supabase-js";
import { getDeviceId } from "@/lib/deviceId";
import { captureError } from "@/lib/sentry";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error("Missing VITE_SUPABASE_URL — check your .env.development file");
}
if (!SUPABASE_ANON_KEY) {
  throw new Error("Missing VITE_SUPABASE_ANON_KEY — check your .env.development file");
}

export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true },
  realtime: { params: { eventsPerSecond: 5 } },
});

// Built-preview Playwright runs cannot import Vite source paths such as
// /src/lib/supabase.ts. Expose the minimum auth hook only in TEST builds so
// browser helpers can establish the same persisted auth-js session.
if (import.meta.env.MODE === "test" && typeof window !== "undefined") {
  (
    window as typeof window & {
      __AASPAAS_TEST_AUTH__?: {
        supabaseUrl: string;
        signInWithPassword: (email: string, password: string) => Promise<void>;
      };
    }
  ).__AASPAAS_TEST_AUTH__ = {
    supabaseUrl: SUPABASE_URL,
    signInWithPassword: async (email, password) => {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
  };
}

const AI_GATEWAY_URL = `${SUPABASE_URL}/functions/v1/ai-gateway`;
export const INITIATE_CALL_URL = `${SUPABASE_URL}/functions/v1/initiate-call`;

/** Abort initiate-call if Exotel / edge does not respond in time. */
const INITIATE_CALL_TIMEOUT_MS = 20_000;

export async function invokeInitiateCall(body: {
  caller_phone: string;
  vendor_phone: string;
  service_mode: string;
}): Promise<{ success: boolean; call_sid?: string; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INITIATE_CALL_TIMEOUT_MS);
  try {
    const resp = await fetch(INITIATE_CALL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = (await resp.json()) as {
      success?: boolean;
      call_sid?: string;
      error?: string;
    };
    if (!resp.ok || !data.success) {
      const error = data.error ?? `HTTP ${resp.status}`;
      captureError(new Error(error), {
        scope: "invokeInitiateCall",
        status: resp.status,
        service_mode: body.service_mode,
      });
      return { success: false, error };
    }
    return { success: true, call_sid: data.call_sid };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === "AbortError";
    const error = aborted
      ? "Call request timed out"
      : err instanceof Error
        ? err.message
        : "Network error";
    captureError(err, { scope: "invokeInitiateCall", aborted, service_mode: body.service_mode });
    return { success: false, error };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function upsertUser(phone: string): Promise<void> {
  try {
    const lang =
      (typeof localStorage !== "undefined"
        ? localStorage.getItem("aaspaas:language")
        : null) ?? "en";
    const { error } = await supabase.rpc("upsert_app_user", {
      p_phone: phone,
      p_lang: lang,
    });
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
} | null> {
  try {
    // Direct users reads are RLS-blocked for OTP-off callers (auth_user_phone()
    // NULL), so the pre-order trust/ban gate silently never fired. Reuse the
    // existing rate-limited identity RPC instead of a direct table read.
    const { data, error } = await supabase.rpc("lookup_user_by_phone", {
      p_phone: phone,
    });
    if (error) {
      console.error("fetchUserTrust", error);
      return null;
    }
    const row = data?.[0];
    if (!row) return null;
    return {
      trust_score: row.trust_score,
      total_orders: row.total_orders,
      is_banned: row.is_banned,
    };
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
  request_id?: string;
  type?: string;
  route?: string;
  route_params?: Record<string, string>;
}): Promise<void> {
  if (!record.route?.trim()) {
    captureError(new Error("invokeNotifyVendor missing route"), {
      notifyHelper: "invokeNotifyVendor",
      notificationType: record.type ?? null,
      vendorId: record.vendor_id,
      callSiteStack: new Error().stack?.split("\n").slice(0, 10).join("\n"),
    });
  }
  try {
    await supabase.functions.invoke("notify-vendor", {
      body: { record },
    });
  } catch {
    /* ignore */
  }
}

export type CategorySuggestionOutcome =
  | "high_existing"
  | "medium_existing"
  | "new_suggested"
  | "medium_new"
  | "new_pending"
  | "new_auto_approved"
  | "low_confidence";

export type CategorySuggestionResult = {
  success: boolean;
  outcome?: CategorySuggestionOutcome;
  category_id?: string;
  category_name?: string;
  service_mode?: string;
  confidence?: number;
  reasoning?: string;
  emoji?: string | null;
  requires_confirm?: boolean;
  pending_review?: boolean;
  top_picks?: Array<{
    id: string;
    label: string;
    emoji: string | null;
    service_mode: string;
  }>;
  error?: string;
};

export async function invokeSuggestCategory(body: {
  description: string;
  vendor_id?: string;
  create_pending?: boolean;
  device_id?: string;
}): Promise<CategorySuggestionResult> {
  try {
    const { data, error } = await supabase.functions.invoke("suggest-category", {
      body: {
        ...body,
        device_id: body.device_id ?? getDeviceId(),
      },
    });
    if (error) {
      return { success: false, error: error.message };
    }
    return (data ?? { success: false, error: "empty_response" }) as CategorySuggestionResult;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "suggest_category_failed",
    };
  }
}

/** Best-effort push to user devices; never throws. */
export function invokeNotifyUser(payload: {
  user_phone: string;
  title: string;
  body: string;
  type?: string;
  order_id?: string;
  post_id?: string;
  route?: string;
  route_params?: Record<string, string>;
}): void {
  if (!payload.route?.trim()) {
    captureError(new Error("invokeNotifyUser missing route"), {
      notifyHelper: "invokeNotifyUser",
      notificationType: payload.type ?? null,
      userPhone: payload.user_phone,
      callSiteStack: new Error().stack?.split("\n").slice(0, 10).join("\n"),
    });
  }
  void supabase.functions.invoke("notify-user", { body: payload }).catch(() => {});
}

/** Best-effort push to admin; never throws. */
export async function invokeNotifyAdmin(
  title: string,
  body: string,
  options?: { type?: string; route?: string; route_params?: Record<string, string> },
): Promise<void> {
  try {
    await supabase.functions.invoke("notify-admin", {
      body: { title, body, ...options },
    });
  } catch {
    /* ignore */
  }
}

export type DeleteAccountResult =
  | { ok: true; type?: string; message?: string }
  | { ok: false; error: string };

export async function invokeDeleteAccount(
  phone: string,
  type: "customer" | "vendor",
  deviceId: string,
): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body: { phone, type, device_id: deviceId },
    });
    if (error) {
      console.error("invokeDeleteAccount", error);
      return { ok: false, error: error.message };
    }
    const payload = data as { ok?: boolean; error?: string; type?: string; message?: string } | null;
    if (!payload?.ok) {
      return { ok: false, error: payload?.error ?? "delete_failed" };
    }
    return { ok: true, type: payload.type, message: payload.message };
  } catch (err) {
    console.error("invokeDeleteAccount", err);
    return { ok: false, error: err instanceof Error ? err.message : "delete_failed" };
  }
}

export async function invokeCancelDeletion(
  phone: string,
  deviceId: string,
): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.functions.invoke("delete-account", {
      body: { phone, action: "cancel", device_id: deviceId },
    });
    if (error) {
      console.error("invokeCancelDeletion", error);
      return { ok: false, error: error.message };
    }
    const payload = data as { ok?: boolean; error?: string; message?: string } | null;
    if (!payload?.ok) {
      return { ok: false, error: payload?.error ?? "cancel_failed" };
    }
    return { ok: true, message: payload.message };
  } catch (err) {
    console.error("invokeCancelDeletion", err);
    return { ok: false, error: err instanceof Error ? err.message : "cancel_failed" };
  }
}

export type VerificationStatus =
  | "unverified"
  | "identity_linked"
  | "business_verified"
  | "green_pending"
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
  /** When false, hidden from Radar/category browse/saved neighbours; feed posts unaffected. */
  discoverable?: boolean;
  latitude: number | null;
  longitude: number | null;
  verification_status: VerificationStatus;
  shop_photo_url: string | null;
  /** Meters from shop coords at photo capture; 0 = location set from photo with no prior GPS. */
  gps_match_distance?: number | null;
  upi_verified: boolean;
  is_manual_verified: boolean;
  created_at: string;
  subscription_status?: string;
  trial_ends_at?: string;
  subscription_current_period_end?: string;
  grace_ends_at?: string;
  waiveoff_percent?: number;
  waiveoff_months_remaining?: number;
  subscription_id?: string;
  /** True when vendor has an active paid subscription (not trial/grace). */
  subscription_active?: boolean;
  referral_code?: string | null;
  last_updated?: string | null;
  /** Hyperlocal service vs delivery; drives reputation copy on cards. */
  service_mode?: "help" | "delivery" | "appointment" | "booking";
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
  /** First day of current ledger/financial year (date). */
  ledger_cycle_start?: string | null;
  /** Khata credit enabled when khata_amber_limit > 0. */
  khata_amber_limit?: number;
  khata_red_limit?: number;
  is_banned?: boolean;
  ban_reason?: string | null;
  vendor_type?: "shop" | "home" | "visiting" | null;
  base_type?: "shop" | "home" | "none" | null;
  serves_at_vendor_place?: boolean | null;
  serves_at_customer_place?: boolean | null;
  photo_selfie?: string | null;
  profile_status?: "draft" | "complete";
  /** Max km vendor serves; 9999 = pan-India. */
  service_radius_km: number;
};

/** app_config keys for Razorpay vendor checkout (raw string values from DB). */
export type VendorSubscriptionAppConfig = {
  payments_enabled: string;
  vendor_subscription_price: string;
  razorpay_key_id: string;
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

export const DISPLAY_NAME: Record<string, string> = {
  "Tyre Service": "Tyre / Puncture",
};

export function displayName(canonical: string): string {
  return DISPLAY_NAME[canonical] ?? canonical;
}

export const SHOP_PHOTOS_BUCKET = "shop-photos";
export const VENDOR_SELFIES_BUCKET = "vendor-selfies";
export const GPS_MATCH_TOLERANCE_M = 75;

import { resolveCategoryFromDB } from "@/lib/categories";

/** One ranked category suggestion from the classify_category gateway action. */
export type ClassifySearchCandidate = {
  label: string;
  emoji: string;
  mode: "help" | "delivery" | "appointment";
};

/**
 * Home search bar contract (5s timeout on the AI call):
 * - "exact": the input IS an active category label — not a guess, go to Radar.
 * - "hint": fixed informational response (government/emergency service).
 * - "candidates": ranked suggestions the user must confirm in the tier sheet.
 * - "fallback": nothing usable — Home falls through to the category grid.
 * There is intentionally no auto-accepted single guess and no "Other" term.
 */
export type ClassifySearchForRadarResult =
  | { outcome: "exact"; query: string }
  | { outcome: "hint"; message: string }
  | { outcome: "candidates"; candidates: ClassifySearchCandidate[] }
  | { outcome: "fallback" };

function parseClassifyCandidates(raw: unknown): ClassifySearchCandidate[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const candidates: ClassifySearchCandidate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      label,
      emoji: typeof rec.emoji === "string" && rec.emoji.trim() ? rec.emoji.trim() : "✨",
      mode:
        rec.mode === "delivery" || rec.mode === "appointment" ? rec.mode : "help",
    });
  }
  return candidates;
}

export async function classifySearchTermForRadar(
  rawInput: string,
  dbCategories: Category[],
): Promise<ClassifySearchForRadarResult> {
  const term = rawInput.trim();
  if (!term) return { outcome: "fallback" };

  const localCanon = await resolveCategoryFromDB(rawInput, dbCategories);
  if (localCanon) return { outcome: "exact", query: localCanon };

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

    if (!resp.ok) return { outcome: "fallback" };

    const data: unknown = await resp.json();
    const result =
      data && typeof data === "object" && "result" in data
        ? (data as { result: Record<string, unknown> }).result
        : null;
    if (!result) return { outcome: "fallback" };

    if (
      result.is_government === true &&
      typeof result.message === "string" &&
      result.message.trim()
    ) {
      return { outcome: "hint", message: result.message.trim() };
    }

    const candidates = parseClassifyCandidates(result.candidates);
    if (candidates.length === 0) return { outcome: "fallback" };
    return { outcome: "candidates", candidates };
  } catch {
    return { outcome: "fallback" };
  }
}

export type AiBridgeBriefResult =
  | { ok: true; brief: string }
  | { ok: false; error: string };

export async function buildVendorBrief(payload: {
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

// UPI format check: handle@provider (2–256 chars before @, 2–64 letter TLD).
const UPI_RE = /^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/;
export function isValidUpi(upi: string) {
  return UPI_RE.test(upi.trim());
}

export type RegisterVendorParams = {
  name: string;
  shop_name: string;
  category: string;
  phone: string;
  upi_id: string;
  service_mode: string;
  vendor_type: string;
  vendor_note: string | null;
  latitude: number | null;
  longitude: number | null;
  referral_code: string;
  profile_status: "draft" | "complete";
  category_ids: string[];
  category_service_modes: string[];
  /** Authoritative per-category mode sets: { [categoryId]: ["help","delivery"] }. */
  category_modes: Record<string, Array<"help" | "delivery" | "appointment">>;
  upi_qr_url?: string | null;
  upi_qr_payee_id?: string | null;
  base_type: "shop" | "home" | "none";
  serves_at_vendor_place: boolean;
  serves_at_customer_place: boolean;
  service_radius_km: number;
  /** Derived compatibility aggregate; server ignores for per-category stamping. */
  availability_modes?: Array<"help" | "delivery" | "appointment">;
};

export type RegisterVendorResult =
  | { ok: true; vendorId: string }
  | { ok: false; error: string; code?: string };

/** Atomic vendor registration RPC. referral_code must be referralCodeFromPhone(phone). */
export async function invokeRegisterVendor(
  params: RegisterVendorParams,
): Promise<RegisterVendorResult> {
  try {
    const { data, error } = await supabase.rpc("register_vendor", {
      p_name: params.name,
      p_shop_name: params.shop_name,
      p_category: params.category,
      p_phone: params.phone,
      p_upi_id: params.upi_id,
      p_service_mode: params.service_mode,
      p_vendor_type: params.vendor_type,
      p_vendor_note: params.vendor_note,
      p_latitude: params.latitude,
      p_longitude: params.longitude,
      p_referral_code: params.referral_code,
      p_profile_status: params.profile_status,
      p_category_ids: params.category_ids,
      p_category_service_modes: params.category_service_modes,
      p_category_modes: params.category_modes,
      p_upi_qr_url: params.upi_qr_url ?? null,
      p_upi_qr_payee_id: params.upi_qr_payee_id ?? null,
      p_base_type: params.base_type,
      p_serves_at_vendor_place: params.serves_at_vendor_place,
      p_serves_at_customer_place: params.serves_at_customer_place,
      p_service_radius_km: params.service_radius_km,
      p_availability_modes: params.availability_modes ?? undefined,
    });
    if (error) {
      return { ok: false, error: error.message, code: error.code };
    }
    const vendorId = typeof data === "string" ? data : null;
    if (!vendorId) {
      return { ok: false, error: "register_vendor_empty_response" };
    }
    return { ok: true, vendorId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "register_vendor_failed",
    };
  }
}

export type AttachPendingCategoryResult =
  | { ok: true }
  | { ok: false; error: string; code?: string };

export async function invokeAttachPendingCategory(params: {
  vendorId: string;
  vendorPhone: string;
  categoryId: string;
  serviceMode: string;
  modes?: Array<"help" | "delivery" | "appointment">;
}): Promise<AttachPendingCategoryResult> {
  try {
    const { error } = await supabase.rpc("attach_pending_category", {
      p_vendor_id: params.vendorId,
      p_vendor_phone: params.vendorPhone,
      p_category_id: params.categoryId,
      p_service_mode: params.serviceMode,
      p_modes: params.modes ?? [params.serviceMode as "help" | "delivery" | "appointment"],
    });
    if (error) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "attach_pending_category_failed",
    };
  }
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
  const status = v.verification_status;
  const verificationComplete =
    status === "business_verified" || status === "green_pending";
  return (
    !!v.shop_photo_url &&
    v.upi_verified &&
    isValidPhone(v.phone ?? "") &&
    verificationComplete
  );
}

export function isGreenLive(v: Vendor) {
  return meetsGreenCriteria(v) && v.is_manual_verified;
}

export async function fetchActiveVendorCategoryLabels(): Promise<Set<string>> {
  const [legacyRes, vcRes, activeVendorRes] = await Promise.all([
    supabase.from("vendors").select("category").eq("is_active", true).eq("discoverable", true),
    supabase
      .from("vendor_categories")
      .select("vendor_id, categories(label)")
      .eq("status", "approved"),
    supabase.from("vendors").select("id").eq("is_active", true).eq("discoverable", true),
  ]);

  const activeVendorIds = new Set((activeVendorRes.data ?? []).map((v) => v.id));
  const labels = new Set<string>();

  for (const row of legacyRes.data ?? []) {
    if (typeof row.category === "string" && row.category.length > 0) {
      labels.add(row.category);
    }
  }

  for (const row of vcRes.data ?? []) {
    if (!activeVendorIds.has(row.vendor_id)) continue;
    const cats = row.categories as { label: string } | { label: string }[] | null;
    const category = Array.isArray(cats) ? cats[0] : cats;
    if (category?.label) labels.add(category.label);
  }

  return labels;
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("*")
    .eq("is_active", true)
    .order("sort_order", { ascending: true });

  if (error) throw error;

  // Home must show the full active catalog. The old three-query vendor filter
  // only answered "does an active vendor exist anywhere?", not whether one is
  // reachable for this customer. Radar is the correct gatekeeper: it enforces
  // distance <= min(customer search bracket, each vendor's service_radius_km).
  return (data ?? []) as Category[];
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
  console.warn(
    "[emojiForVendorCategory] live categories array not passed; using default emoji",
    { category },
  );
  return "✨";
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
        data.forEach((row) => {
          const cats = row.categories as { label?: string } | { label?: string }[] | null;
          const category = Array.isArray(cats) ? cats[0] : cats;
          const original = category?.label;
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
