import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  ShieldCheck,
  Trash2,
  Wrench,
  CheckCircle2,
  Bell,
  Phone,
  MapPin,
  Camera,
  Zap,
  Globe,
  Moon,
  Sun,
  Users,
  ShieldAlert,
  Search,
  CheckCircle,
  XCircle,
  Store,
  Loader2,
  ChevronRight,
} from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { toast } from "sonner";
import {
  applyPermissionRequestResult,
  checkNativePermissionStatuses,
  DEFAULT_NATIVE_PERMISSION_STATUSES,
  isPermissionGranted,
  requestNativePermission,
  type NativePermissionKind,
  type NativePermissionStatuses,
} from "@/lib/nativePermissions";
import {
  supabase,
  invokeNotifyUser,
  invokeNotifyVendor,
  invokeDeleteAccount,
  invokeCancelDeletion,
  useCategoryLabel,
  useServiceModeLabel,
  type Vendor,
} from "@/lib/supabase";
import { NotificationBell } from "@/components/NotificationBell";
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { stopAllVendorLocationTracking } from "@/lib/vendorBackgroundLocation";
import { getUserPhone, clearUserPhone, ensureUserDeviceLink, saveUserPhone, migrateUserPhone, restoreVendorSession } from "@/lib/userIdentity";
import { showClearMyDataSuccessThenReload } from "@/lib/clearMyDataFeedback";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { fetchVendorOwn } from "@/lib/vendorRead";
import { formatVendorDeletionDate } from "@/lib/vendorDeletion";
import { logAdminAction } from "@/lib/adminAudit";
import { deleteAdminLowRating, loadAdminLowRatings } from "@/lib/adminLowRatings";
import { warnFlaggedUser as runWarnFlaggedUser } from "@/lib/warnFlaggedUser";
import { applyVendorWaiveoff as runApplyVendorWaiveoff } from "@/lib/applyVendorWaiveoff";
import { getDeviceId } from "@/lib/deviceId";
import { maskPhoneLast4 } from "@/lib/khataDisplay";
import {
  ADMIN_QUERY_MAX_ROWS,
  ADMIN_VENDOR_LIST_PAGE_SIZE,
  fetchAllPages,
  fetchByIdChunks,
  warnIfQueryTruncated,
} from "@/lib/adminQueryPagination";
import { useLanguage } from "@/lib/language";
import { useTheme } from "@/lib/theme";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useFeedNotificationsEnabled } from "@/hooks/useFeedNotificationsEnabled";
import { FeedReachChips } from "@/components/FeedReachChips";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { LANGUAGE_LABELS, type Language } from "@/lib/strings";
import { useUserAddresses } from "@/hooks/useUserAddresses";
import {
  VendorSettings,
  VendorSettingsReferEarn,
  type VendorReferralCredits,
} from "@/components/settings/VendorSettings";
import { VendorMyBusiness } from "@/components/settings/VendorMyBusiness";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  SettingsPageHeader,
  SettingsCard,
  SettingsRow,
  SettingsCollapsible,
  SettingsParentCollapsible,
} from "@/components/settings/SettingsSection";
import { AdminSystemHealthCard } from "@/components/settings/AdminSystemHealthCard";
import { captureError } from "@/lib/sentry";
import {
  TRUST_TIER_GROUPS,
  computeTrustLevelForBusiness,
  computeTrustLevelsByVendorCategory,
  statusForBusinessCheck,
  tierReachedForBusiness,
  trustLevelRank,
  vendorCategoryTrustKey,
  type BusinessLocationRow,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";
import { resolveAdminBusinessPayeeAndPin } from "@/lib/adminBusinessPayee";
import { setOverlayBackHandler } from "@/lib/overlayBackBridge";

type AdminVendorCategory = {
  category_id: string | null;
  label: string;
  emoji: string;
  service_mode: string;
  is_primary: boolean;
  shop_photo_url: string | null;
  gps_match_distance: number | null;
  location_accuracy: number | null;
  photo_accuracy: number | null;
  verification_status: string | null;
  is_manual_verified: boolean;
  latitude: number | null;
  longitude: number | null;
  upi_id: string | null;
};

type AdminVendorListRow = {
  id: string;
  name: string;
  shop_name: string;
  category: string;
  service_mode: string | null;
  vendor_type: Vendor["vendor_type"];
  phone: string;
  is_manual_verified: boolean;
  is_active: boolean;
  shop_photo_url: string | null;
  upi_id: string | null;
  latitude: number | null;
  longitude: number | null;
  referral_code: string | null;
  last_updated: string | null;
  gps_match_distance: number | null;
  upi_verified: boolean;
  is_banned: boolean;
  ban_reason: string | null;
  deletion_requested_at: string | null;
  categories: AdminVendorCategory[];
  trustLevel: TrustLevel;
  verifications: VendorVerificationRow[];
};

const VENDOR_LIST_SELECT =
  "id, name, shop_name, category, service_mode, vendor_type, phone, is_manual_verified, is_active, is_banned, ban_reason, deletion_requested_at, shop_photo_url, upi_id, latitude, longitude, referral_code, last_updated, gps_match_distance, upi_verified, verification_status";

type AdminVendorListFilter = "attention" | "green_ready" | "all";

const TRUST_BADGE_CLASS: Record<Exclude<TrustLevel, "Unverified">, string> = {
  Diamond: "bg-sidebar-primary text-sidebar-primary-foreground",
  Gold: "bg-warning text-primary-foreground",
  Silver: "bg-muted text-foreground border border-surface-border",
  Bronze: "bg-surface-raised text-foreground border border-warning/40",
};

const VERIFICATION_CHECK_META: {
  check_type: string;
  labelKey:
    | "admin_check_label_upi_format"
    | "admin_check_label_upi_pennydrop"
    | "admin_check_label_photo_shop"
    | "admin_check_label_photo_selfie"
    | "admin_check_label_gps"
    | "admin_check_label_admin_check"
    | "admin_check_label_aadhaar_digilocker";
  icon: string;
}[] = [
  { check_type: "upi_format", labelKey: "admin_check_label_upi_format", icon: "💳" },
  { check_type: "photo_shop", labelKey: "admin_check_label_photo_shop", icon: "🏪" },
  { check_type: "photo_selfie", labelKey: "admin_check_label_photo_selfie", icon: "🤳" },
  { check_type: "gps", labelKey: "admin_check_label_gps", icon: "📍" },
  { check_type: "admin_check", labelKey: "admin_check_label_admin_check", icon: "✅" },
  { check_type: "upi_pennydrop", labelKey: "admin_check_label_upi_pennydrop", icon: "🏦" },
  { check_type: "aadhaar_digilocker", labelKey: "admin_check_label_aadhaar_digilocker", icon: "🪪" },
];

const VERIFICATION_CHECK_BY_TYPE = Object.fromEntries(
  VERIFICATION_CHECK_META.map((m) => [m.check_type, m]),
) as Record<string, (typeof VERIFICATION_CHECK_META)[number]>;

function buildAdminVendorCategoriesMap(
  rows: {
    vendor_id: string;
    category_id: string | null;
    is_primary: boolean | null;
    service_mode: string | null;
    shop_photo_url?: string | null;
    gps_match_distance?: number | null;
    location_accuracy?: number | null;
    photo_accuracy?: number | null;
    verification_status?: string | null;
    is_manual_verified?: boolean | null;
    latitude?: number | null;
    longitude?: number | null;
    upi_id?: string | null;
    categories:
      | { label: string; emoji: string }
      | { label: string; emoji: string }[]
      | null;
  }[],
): Map<string, AdminVendorCategory[]> {
  const map = new Map<string, AdminVendorCategory[]>();

  for (const row of rows) {
    const joined = row.categories;
    const resolved = Array.isArray(joined) ? joined[0] : joined;
    if (!resolved?.label) continue;

    const list = map.get(row.vendor_id) ?? [];
    list.push({
      category_id: row.category_id,
      label: resolved.label,
      emoji: resolved.emoji ?? "✨",
      service_mode: row.service_mode ?? "help",
      is_primary: row.is_primary === true,
      shop_photo_url: row.shop_photo_url ?? null,
      gps_match_distance:
        row.gps_match_distance != null ? Number(row.gps_match_distance) : null,
      location_accuracy:
        row.location_accuracy != null ? Number(row.location_accuracy) : null,
      photo_accuracy: row.photo_accuracy != null ? Number(row.photo_accuracy) : null,
      verification_status: row.verification_status ?? null,
      is_manual_verified: row.is_manual_verified === true,
      latitude: row.latitude != null ? Number(row.latitude) : null,
      longitude: row.longitude != null ? Number(row.longitude) : null,
      upi_id: row.upi_id ?? null,
    });
    map.set(row.vendor_id, list);
  }

  const out = new Map<string, AdminVendorCategory[]>();
  for (const [vendorId, list] of map) {
    list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    out.set(vendorId, list);
  }
  return out;
}

function adminTrustBadgeLabel(
  level: TrustLevel,
  s: {
    radar_trust_badge_diamond: string;
    radar_trust_badge_gold: string;
    radar_trust_badge_silver: string;
    radar_trust_badge_bronze: string;
  },
): string | null {
  switch (level) {
    case "Diamond":
      return s.radar_trust_badge_diamond;
    case "Gold":
      return s.radar_trust_badge_gold;
    case "Silver":
      return s.radar_trust_badge_silver;
    case "Bronze":
      return s.radar_trust_badge_bronze;
    default:
      return null;
  }
}

function AdminTrustLevelBadge({ level }: { level: TrustLevel }) {
  const { s } = useLanguage();
  if (level === "Unverified") return null;
  const label = adminTrustBadgeLabel(level, s);
  if (!label) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none whitespace-nowrap shrink-0",
        TRUST_BADGE_CLASS[level],
      )}
    >
      {label}
    </span>
  );
}

function AdminVendorCategoryChips({
  categories,
  fallbackLabel,
  getLabel,
}: {
  categories: AdminVendorCategory[];
  fallbackLabel: string;
  getLabel: (label: string) => string;
}) {
  const chips =
    categories.length > 0
      ? categories
      : fallbackLabel
        ? [
            {
              category_id: null,
              label: fallbackLabel,
              emoji: "✨",
              service_mode: "help",
              is_primary: true,
              shop_photo_url: null,
              gps_match_distance: null,
              location_accuracy: null,
              photo_accuracy: null,
              verification_status: null,
              is_manual_verified: false,
              latitude: null,
              longitude: null,
              upi_id: null,
            } satisfies AdminVendorCategory,
          ]
        : [];

  if (chips.length === 0) return null;

  const scrollable = chips.length > 1;

  return (
    <div
      className={cn(
        "mt-1 flex gap-1.5 min-w-0",
        scrollable ? "overflow-x-auto pb-0.5 scrollbar-none" : "flex-wrap",
      )}
    >
      {chips.map((cat, index) => (
        <span
          key={`${cat.label}-${index}`}
          className={cn(
            "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] shrink-0",
            "border border-surface-border bg-surface text-muted-foreground",
            index === 0 && "font-semibold text-foreground border-brand/40 bg-brand/10",
          )}
        >
          <span aria-hidden>{cat.emoji}</span>
          <span className="truncate max-w-[8rem]">{getLabel(cat.label)}</span>
        </span>
      ))}
    </div>
  );
}

function AdminVendorTypeLabel({ vendorType }: { vendorType: Vendor["vendor_type"] }) {
  const { s } = useLanguage();
  if (vendorType === "home") {
    return (
      <p className="text-[11px] text-muted-foreground mt-0.5">{s.radar_vendor_home_based}</p>
    );
  }
  if (vendorType === "visiting") {
    return (
      <p className="text-[11px] text-muted-foreground mt-0.5">{s.radar_vendor_visits_you}</p>
    );
  }
  return null;
}

function verificationStatusChipClass(status: string): string {
  if (status === "passed") {
    return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30";
  }
  if (status === "failed") {
    return "bg-destructive/10 text-destructive border-destructive/30";
  }
  if (status === "pending") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30";
  }
  if (status === "coming_soon") {
    return "bg-muted text-muted-foreground border-border";
  }
  return "bg-muted text-muted-foreground border-border";
}

const LARGE_TEXT_KEY = "aaspaas:large_text";
const VOICE_LANG_KEY = "aaspaas:voice_lang";

type VoiceInputLang = "auto" | "en-IN" | "hi-IN" | "mr-IN";

const VOICE_INPUT_OPTIONS: { code: VoiceInputLang; labelKey: "settings_voiceAuto" | "settings_voiceEnglish" | "settings_voiceHindi" | "settings_voiceMarathi" }[] = [
  { code: "auto", labelKey: "settings_voiceAuto" },
  { code: "en-IN", labelKey: "settings_voiceEnglish" },
  { code: "hi-IN", labelKey: "settings_voiceHindi" },
  { code: "mr-IN", labelKey: "settings_voiceMarathi" },
];

const VERIFY_ITEM_IDS = [
  "phone_called",
  "name_match",
  "aware",
  "shop_exists",
  "shop_name_match",
  "category_match",
  "service_mode_correct",
  "no_duplicate",
  "photo_genuine",
  "upi_verified",
  "no_suspicious",
  "rules_understood",
  "gps_photo_independent",
] as const;
const VERIFY_CHECK_COUNT = VERIFY_ITEM_IDS.length;

function emptyVerifyChecks(): Record<string, boolean> {
  return Object.fromEntries(VERIFY_ITEM_IDS.map((id) => [id, false]));
}

function verifyProgressKey(vendorId: string) {
  return `aaspaas:verify_progress:${vendorId}`;
}

function loadVerifyChecks(vendorId: string): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(verifyProgressKey(vendorId));
    if (!saved) return {};
    const parsed = JSON.parse(saved) as Record<string, boolean>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function hasVerifyInProgress(vendorId: string): boolean {
  return Object.values(loadVerifyChecks(vendorId)).some(Boolean);
}

function adminServiceModeLabel(mode: string | null | undefined): string {
  if (mode === "delivery") return "🚚 Delivery";
  if (mode === "appointment") return "📅 Appointment";
  return "🚶 Help";
}

import { gpsEffectiveTolerance } from "@/lib/gpsMatch";

// Client-side mirror of the server whitelist inside admin_update_app_config
// (supabase/migrations/20260719140001_admin_config_ops_keys_and_fcm_grant.sql;
//  originally introduced in 20260719120001). Keep BOTH lists in sync when adding a key.
const ADMIN_CONFIG_WHITELIST = [
  // Referral + order expiry / near-deadline
  "referral_enabled",
  "help_accept_timeout_hours",
  "help_accept_timeout_minutes",
  "help_near_deadline_minutes",
  "delivery_near_deadline_minutes",
  "appointment_near_deadline_minutes",
  "appointment_accept_timeout_hours",
  // Vendor behaviour
  "vendor_stopped_minutes",
  "vendor_stopped_distance_meters",
  "max_order_message_chars",
  // Referral credits
  "referral_user_credit",
  "referral_vendor_credit_total",
  "referral_vendor_credit_m1",
  "referral_vendor_credit_m2",
  "referral_vendor_credit_m3",
  "referral_veteran_threshold_months",
  // Business / calls
  "vendor_trial_days",
  "vendor_subscription_price",
  "help_call_limit_seconds",
  "delivery_call_limit_seconds",
  "appointment_call_limit_seconds",
  // Feature flags
  "vendor_lead_notify_enabled",
  "localization_enabled",
  "lang_hindi_enabled",
  "lang_marathi_enabled",
  "exotel_secure_calling_enabled",
  "aadhaar_verification_enabled",
  // AI
  "ai_category_confidence_threshold",
  // App
  "feed_notification_radius_km",
  "app_base_url",
  // Operational (payments / KYC / alerts / grace / khata)
  "payments_enabled",
  "razorpay_key_id",
  "razorpay_kyc_date",
  "exotel_kyc_date",
  "exotel_credits_low_threshold_inr",
  "vendor_grace_period_days",
  "khata_amber_limit",
] as const;

type AdminConfigKey = (typeof ADMIN_CONFIG_WHITELIST)[number];

type AdminConfigValueType = "boolean" | "number" | "text";

/** Factory defaults when app_config has no row or default_value is null/empty. */
const ADMIN_CONFIG_FALLBACK_DEFAULTS: Record<AdminConfigKey, string> = {
  referral_enabled: "true",
  help_accept_timeout_hours: "2",
  help_accept_timeout_minutes: "120",
  help_near_deadline_minutes: "30",
  delivery_near_deadline_minutes: "30",
  appointment_near_deadline_minutes: "30",
  appointment_accept_timeout_hours: "2",
  vendor_stopped_minutes: "10",
  vendor_stopped_distance_meters: "200",
  max_order_message_chars: "200",
  referral_user_credit: "2.5",
  referral_vendor_credit_total: "25",
  referral_vendor_credit_m1: "8.34",
  referral_vendor_credit_m2: "8.34",
  referral_vendor_credit_m3: "8.32",
  referral_veteran_threshold_months: "12",
  vendor_trial_days: "30",
  vendor_subscription_price: "99",
  help_call_limit_seconds: "300",
  delivery_call_limit_seconds: "120",
  appointment_call_limit_seconds: "180",
  vendor_lead_notify_enabled: "true",
  localization_enabled: "true",
  lang_hindi_enabled: "true",
  lang_marathi_enabled: "true",
  exotel_secure_calling_enabled: "false",
  aadhaar_verification_enabled: "false",
  ai_category_confidence_threshold: "0.85",
  feed_notification_radius_km: "5",
  app_base_url: "https://aaspaas.in",
  payments_enabled: "false",
  razorpay_key_id: "",
  razorpay_kyc_date: "2026-06-28",
  exotel_kyc_date: "2026-06-28",
  exotel_credits_low_threshold_inr: "200",
  vendor_grace_period_days: "3",
  khata_amber_limit: "0",
};

const ADMIN_CONFIG_TYPES: Partial<Record<AdminConfigKey, AdminConfigValueType>> = {
  referral_enabled: "boolean",
  vendor_lead_notify_enabled: "boolean",
  localization_enabled: "boolean",
  lang_hindi_enabled: "boolean",
  lang_marathi_enabled: "boolean",
  exotel_secure_calling_enabled: "boolean",
  aadhaar_verification_enabled: "boolean",
  payments_enabled: "boolean",
  help_accept_timeout_hours: "number",
  help_accept_timeout_minutes: "number",
  help_near_deadline_minutes: "number",
  delivery_near_deadline_minutes: "number",
  appointment_near_deadline_minutes: "number",
  appointment_accept_timeout_hours: "number",
  vendor_stopped_minutes: "number",
  vendor_stopped_distance_meters: "number",
  max_order_message_chars: "number",
  ai_category_confidence_threshold: "number",
  vendor_trial_days: "number",
  vendor_subscription_price: "number",
  help_call_limit_seconds: "number",
  delivery_call_limit_seconds: "number",
  appointment_call_limit_seconds: "number",
  referral_user_credit: "number",
  referral_vendor_credit_total: "number",
  referral_vendor_credit_m1: "number",
  referral_vendor_credit_m2: "number",
  referral_vendor_credit_m3: "number",
  referral_veteran_threshold_months: "number",
  feed_notification_radius_km: "number",
  exotel_credits_low_threshold_inr: "number",
  vendor_grace_period_days: "number",
  khata_amber_limit: "number",
};

function getAdminConfigType(key: AdminConfigKey): AdminConfigValueType {
  return ADMIN_CONFIG_TYPES[key] ?? "text";
}

function parseAdminConfigBoolean(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "true" || v === "1";
}

function formatAdminConfigDefaultLabel(value: string): string {
  return value === "" ? "(empty)" : value;
}

const ADMIN_CONFIG_LABELS: Record<AdminConfigKey, string> = {
  referral_enabled: "Referral Program Enabled",
  help_accept_timeout_hours: "Help Accept Timeout (hours)",
  help_accept_timeout_minutes: "Help Accept Timeout (minutes)",
  help_near_deadline_minutes: "Help Near-Deadline Warning (minutes)",
  delivery_near_deadline_minutes: "Delivery Near-Deadline Warning (minutes)",
  appointment_near_deadline_minutes: "Appointment Near-Deadline Warning (minutes)",
  appointment_accept_timeout_hours: "Appointment Accept Timeout (hours)",
  vendor_stopped_minutes: "Vendor Stopped Detection (minutes)",
  vendor_stopped_distance_meters: "Vendor Stopped Detection Distance (meters)",
  max_order_message_chars: "Max Order Message Characters",
  referral_user_credit: "Referral Credit — Customer (₹)",
  referral_vendor_credit_total: "Referral Credit — Vendor Total (₹)",
  referral_vendor_credit_m1: "Referral Credit — Vendor Month 1 (₹)",
  referral_vendor_credit_m2: "Referral Credit — Vendor Month 2 (₹)",
  referral_vendor_credit_m3: "Referral Credit — Vendor Month 3 (₹)",
  referral_veteran_threshold_months: "Referral Veteran Threshold (months)",
  vendor_trial_days: "Vendor Trial Period (days)",
  vendor_subscription_price: "Vendor Subscription Price (₹/month)",
  help_call_limit_seconds: "Help Call Time Limit (seconds)",
  delivery_call_limit_seconds: "Delivery Call Time Limit (seconds)",
  appointment_call_limit_seconds: "Appointment Call Time Limit (seconds)",
  vendor_lead_notify_enabled: "Notify Admin on New Vendor Lead",
  localization_enabled: "Localization Enabled",
  lang_hindi_enabled: "Hindi Language Enabled",
  lang_marathi_enabled: "Marathi Language Enabled",
  exotel_secure_calling_enabled: "Exotel Secure Calling Enabled",
  aadhaar_verification_enabled: "Aadhaar / DigiLocker Verification Enabled",
  ai_category_confidence_threshold: "AI Category Confidence Threshold (0–1)",
  feed_notification_radius_km: "Feed Notification Radius (km)",
  app_base_url: "App Base URL",
  payments_enabled: "Payments Enabled",
  razorpay_key_id: "Razorpay Key ID",
  razorpay_kyc_date: "Razorpay KYC Date",
  exotel_kyc_date: "Exotel KYC Date",
  exotel_credits_low_threshold_inr: "Exotel Credits Low Threshold (₹)",
  vendor_grace_period_days: "Vendor Grace Period (days)",
  khata_amber_limit: "Khata Amber Limit Default (₹)",
};

function buildVerifyAutoChecks(
  v: {
    shop_photo_url: string | null;
    gps_match_distance: number | null;
    location_accuracy?: number | null;
    photo_accuracy?: number | null;
    verification_status?: string | null;
    upi_verified: boolean;
  },
): Record<string, boolean> {
  const autoChecks: Record<string, boolean> = {};
  const tol = gpsEffectiveTolerance(v.location_accuracy, v.photo_accuracy);
  if (
    v.shop_photo_url?.trim() &&
    v.gps_match_distance != null &&
    v.verification_status !== "pending_location_review" &&
    v.gps_match_distance <= tol
  ) {
    autoChecks.photo_genuine = true;
    autoChecks.shop_exists = true;
  }
  if (v.upi_verified) {
    autoChecks.upi_verified = true;
  }
  return autoChecks;
}

function gpsMatchAdminLabel(
  distance: number | null | undefined,
  opts?: {
    locationAccuracy?: number | null;
    photoAccuracy?: number | null;
    verificationStatus?: string | null;
  },
): {
  text: string;
  className: string;
} {
  if (distance == null) {
    return { text: "📍 No photo captured yet", className: "text-muted-foreground" };
  }
  if (opts?.verificationStatus === "pending_location_review") {
    const loc = opts.locationAccuracy != null ? Math.round(opts.locationAccuracy) : "?";
    const photo = opts.photoAccuracy != null ? Math.round(opts.photoAccuracy) : "?";
    return {
      text: `⏳ Location review — ${distance}m away (acc ${loc}+${photo} m)`,
      className: "text-amber-600",
    };
  }
  if (distance === 0) {
    return {
      text: "📍 Location set from photo (no prior GPS)",
      className: "text-amber-600",
    };
  }
  const tol = gpsEffectiveTolerance(opts?.locationAccuracy, opts?.photoAccuracy);
  if (distance <= tol) {
    return {
      text: `✅ GPS matched — ${distance}m from shop (tol ${Math.round(tol)}m)`,
      className: "text-green-600",
    };
  }
  return {
    text: `❌ GPS mismatch — ${distance}m away (tol ${Math.round(tol)}m)`,
    className: "text-red-600",
  };
}

function formatVendorLastUpdated(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const Settings = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const highlightVendorId = (location.state as { highlightVendorId?: string } | null)
    ?.highlightVendorId;
  const [flashVendorId, setFlashVendorId] = useState<string | null>(null);
  const { lang, setLang, s } = useLanguage();
  const { theme, toggleTheme } = useTheme();
  const { config } = useAppConfig();
  const [referEarnVisible, setReferEarnVisible] = useState(true);
  const languageOptions = useMemo(
    () =>
      (Object.entries(LANGUAGE_LABELS) as [Language, string][]).filter(([code]) => {
        if (code === "en") return true;
        if (code === "hi") return config.langHindiEnabled;
        if (code === "mr") return config.langMarathiEnabled;
        return false;
      }),
    [config.langHindiEnabled, config.langMarathiEnabled],
  );
  const getLabel = useCategoryLabel();
  const getServiceModeLabel = useServiceModeLabel();
  const [titleTaps, setTitleTaps] = useState(0);
  const [adminTabRevealed, setAdminTabRevealed] = useState(false);
  const [identityNonce, setIdentityNonce] = useState(0);
  const userPhone = getUserPhone();
  void identityNonce;
  const deviceId = getDeviceId();
  const vendorId = localStorage.getItem("aaspaas:vendor_id");
  const isVendor = Boolean(vendorId?.trim());
  const [phoneEntryOpen, setPhoneEntryOpen] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminAuthChecked, setAdminAuthChecked] = useState(false);
  const [adminLoginEmail, setAdminLoginEmail] = useState("");
  const [adminLoginPassword, setAdminLoginPassword] = useState("");
  const [adminLoginError, setAdminLoginError] = useState<string | null>(null);
  const [adminLoginSubmitting, setAdminLoginSubmitting] = useState(false);
  const [adminSessionEmail, setAdminSessionEmail] = useState<string | null>(null);
  const [devPhone, setDevPhone] = useState(userPhone ?? "");

  const adminRpcLabel = () => getUserPhone()?.trim() || null;
  const adminAuditLabel = () => getUserPhone()?.trim() || adminSessionEmail || null;

  const checkAdminSession = useCallback(async (): Promise<boolean> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setIsAdmin(false);
      setAdminSessionEmail(null);
      return false;
    }

    setAdminSessionEmail(session.user.email?.trim() || null);

    const { data, error } = await supabase.rpc("is_admin_session");
    if (error) {
      console.error("is_admin_session", error);
      setIsAdmin(false);
      return false;
    }

    const admin = data === true;
    setIsAdmin(admin);
    return admin;
  }, []);

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [vendorExtras, setVendorExtras] = useState<{
    referralCredits: VendorReferralCredits;
  } | null>(null);
  const identityPhone = (vendor?.phone ?? "").trim() || (userPhone ?? "").trim() || null;

  const [adminStats, setAdminStats] = useState({
    totalOrders: 0,
    ordersToday: 0,
    ordersThisWeek: 0,
    totalVendors: 0,
    totalCustomers: 0,
    activeVendorsToday: 0,
    newVendorsThisWeek: 0,
    unverifiedVendors: 0,
    greenPendingVendors: 0,
    stuckOrders: 0,
    avgVendorRating: 0,
    riskyUsers: 0,
    totalReferrals: 0,
  });

  const [vendorList, setVendorList] = useState<AdminVendorListRow[]>([]);
  const [vendorSearch, setVendorSearch] = useState("");
  const [vendorListFilter, setVendorListFilter] = useState<AdminVendorListFilter>("attention");
  const [vendorListHasMore, setVendorListHasMore] = useState(false);
  const [vendorListLoading, setVendorListLoading] = useState(false);
  const vendorListRef = useRef(vendorList);
  vendorListRef.current = vendorList;
  const [pendingCategories, setPendingCategories] = useState<
    {
      id: string;
      label: string;
      emoji: string;
      service_mode: string;
      ai_confidence: string | null;
      ai_confidence_score: number | null;
      ai_reasoning: string | null;
      ai_service_mode_reasoning: string | null;
      proposed_aliases: string[];
      overlap_category_label: string | null;
      overlap_reasoning: string | null;
      suggestion_count: number;
      suggested_by_vendor_id: string | null;
      suggested_vendor_name: string | null;
      license_type: string | null;
      license_confidence_score: number | null;
      license_reasoning: string | null;
      license_review_status: string | null;
    }[]
  >([]);
  const [pendingLicenses, setPendingLicenses] = useState<
    {
      id: string;
      label: string;
      emoji: string | null;
      license_type: string | null;
      license_confidence_score: number | null;
      license_reasoning: string | null;
      is_active: boolean;
      status: string | null;
    }[]
  >([]);
  const [pendingAliases, setPendingAliases] = useState<
    {
      id: string;
      term: string;
      confidence: number | null;
      ai_reasoning: string | null;
      source: string;
      category_id: string;
      category_label: string;
      category_emoji: string;
      suggested_by_vendor_id: string | null;
      suggested_vendor_name: string | null;
    }[]
  >([]);
  const [pendingVendorBusinesses, setPendingVendorBusinesses] = useState<
    {
      vendor_category_id: string;
      vendor_id: string;
      shop_name: string | null;
      vendor_phone: string | null;
      vendor_name: string | null;
      category_id: string;
      category_label: string;
      category_emoji: string | null;
      brand_name: string | null;
      created_at: string;
      approved_businesses: Array<{
        category_id: string;
        label: string;
        emoji: string | null;
        brand_name: string | null;
      }>;
    }[]
  >([]);
  const [modeConfidenceReviews, setModeConfidenceReviews] = useState<
    {
      id: string;
      category_id: string;
      category_label: string;
      category_emoji: string;
      current_default_mode: string;
      proposed_mode: string;
      default_mode_vendor_count: number;
      proposed_mode_vendor_count: number;
      created_at: string;
    }[]
  >([]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingAliasAction, setPendingAliasAction] = useState<string | null>(null);
  const [pendingLicenseAction, setPendingLicenseAction] = useState<string | null>(null);
  const [licenseBackfillRunning, setLicenseBackfillRunning] = useState(false);
  const [pendingBusinessAction, setPendingBusinessAction] = useState<string | null>(null);
  const [modeConfidenceAction, setModeConfidenceAction] = useState<string | null>(null);
  const [modeConfidenceVendors, setModeConfidenceVendors] = useState<
    Record<string, { shop_name: string | null; phone: string | null }[]>
  >({});
  const [modeConfidenceVendorsLoading, setModeConfidenceVendorsLoading] = useState<string | null>(
    null,
  );
  const [modeConfidenceExpanded, setModeConfidenceExpanded] = useState<string | null>(null);
  const [flaggedUsers, setFlaggedUsers] = useState<
    {
      phone: string;
      trust_score: number;
      noshow_count: number;
      fake_count: number;
      is_banned: boolean;
      ban_reason: string | null;
      warn_count: number;
      last_warned_at: string | null;
    }[]
  >([]);
  const [flaggedAction, setFlaggedAction] = useState<string | null>(null);
  const adminUserActionLockRef = useRef(new Set<string>());
  const [banDialog, setBanDialog] = useState<{ open: boolean; phone: string | null }>({
    open: false,
    phone: null,
  });
  const [banReason, setBanReason] = useState("");
  const [vendorBanDialog, setVendorBanDialog] = useState<{
    open: boolean;
    vendor: (typeof vendorList)[number] | null;
  }>({ open: false, vendor: null });
  const [vendorBanReason, setVendorBanReason] = useState("");
  const [vendorBanAction, setVendorBanAction] = useState<string | null>(null);
  const [vendorClearDeletionDialog, setVendorClearDeletionDialog] = useState<{
    open: boolean;
    vendor: (typeof vendorList)[number] | null;
  }>({ open: false, vendor: null });
  const [vendorClearDeletionReason, setVendorClearDeletionReason] = useState("");
  const adminVendorActionLockRef = useRef(new Set<string>());
  const [verifying, setVerifying] = useState<string | null>(null);
  const adminVerifyLockRef = useRef(new Set<string>());
  const [verifySheet, setVerifySheet] = useState<{
    open: boolean;
    vendor: (typeof vendorList)[number] | null;
    category: AdminVendorCategory | null;
  }>({ open: false, vendor: null, category: null });
  const verifyHistoryPushedRef = useRef(false);
  const [verifyChecks, setVerifyChecks] = useState<Record<string, boolean>>({});
  const [verifyAutoTicked, setVerifyAutoTicked] = useState<Set<string>>(() => new Set());
  const [verifyReferrerLabel, setVerifyReferrerLabel] = useState<string | null>(null);
  const [verifyBusinessPicker, setVerifyBusinessPicker] = useState<{
    open: boolean;
    vendor: (typeof vendorList)[number] | null;
    mode: "verify" | "unverify";
  }>({ open: false, vendor: null, mode: "verify" });
  const {
    addresses,
    loading: addressesLoading,
    failed: addressesFailed,
    refresh: refreshAddresses,
  } = useUserAddresses();
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [editAddressValue, setEditAddressValue] = useState("");
  const [deleteAddressId, setDeleteAddressId] = useState<string | null>(null);
  const [clearDataOpen, setClearDataOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [dualRoleDelete, setDualRoleDelete] = useState(false);
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);
  const [vendorDeletionRequestedAt, setVendorDeletionRequestedAt] = useState<string | null>(null);
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const [permissionStatuses, setPermissionStatuses] = useState<NativePermissionStatuses>(
    DEFAULT_NATIVE_PERMISSION_STATUSES,
  );
  /** Skip resume refresh while an OS permission dialog is open (avoids false ✅). */
  const permissionRequestInFlightRef = useRef(false);
  const [deletingAddress, setDeletingAddress] = useState(false);
  const [savingAddress, setSavingAddress] = useState(false);
  const [voiceInputLang, setVoiceInputLang] = useState<VoiceInputLang>(() => {
    const stored = localStorage.getItem(VOICE_LANG_KEY);
    if (stored === "auto") return "auto";
    if (stored === "en-IN" || stored === "hi-IN" || stored === "mr-IN") return stored;
    return "auto";
  });
  const [largeText, setLargeText] = useState(() => {
    try {
      return localStorage.getItem(LARGE_TEXT_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [addressesOpen, setAddressesOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [accountStandingOpen, setAccountStandingOpen] = useState(false);
  const [feedDiscoveryOpen, setFeedDiscoveryOpen] = useState(false);
  const [userTrust, setUserTrust] = useState<{
    trust_score: number | null;
    warn_count: number | null;
    is_banned: boolean;
  } | null>(null);
  // True only when the trust RPC itself failed — distinct from "no row yet",
  // which is a legitimately good standing, not an unknown one.
  const [trustLoadFailed, setTrustLoadFailed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [shopOpen, setShopOpen] = useState(() => Boolean(vendorId?.trim()));
  const initialVendorPanelTab =
    (location.state as { vendorSettingsTab?: string } | null)?.vendorSettingsTab === "preferences"
      ? "preferences"
      : "business";
  const [vendorPanelTab, setVendorPanelTab] = useState<"business" | "preferences">(
    initialVendorPanelTab,
  );
  const openVendorReviews = Boolean(
    (location.state as { openVendorReviews?: boolean } | null)?.openVendorReviews,
  );

  useEffect(() => {
    const tab = (location.state as { vendorSettingsTab?: string } | null)?.vendorSettingsTab;
    if (tab === "business" || tab === "preferences") {
      setVendorPanelTab(tab);
    }
  }, [location.state]);
  const [referOpen, setReferOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);

  const refreshPermissionStatuses = useCallback(() => {
    // Live OS read only — never write/read an app-level permission cache.
    void checkNativePermissionStatuses()
      .then(setPermissionStatuses)
      .catch(() => {
        /* keep last known statuses */
      });
  }, []);

  const handlePermissionRequest = async (kind: NativePermissionKind, deniedLabel: string) => {
    if (!Capacitor.isNativePlatform()) return;

    const current = permissionStatuses[kind];
    if (isPermissionGranted(current)) return;
    if (current === "denied") {
      setPermissionHint(deniedLabel);
      return;
    }

    permissionRequestInFlightRef.current = true;
    try {
      const result = await requestNativePermission(kind);
      // Trust the OS request callback for this kind; never tick ✅ on dismiss alone.
      let live = DEFAULT_NATIVE_PERMISSION_STATUSES;
      try {
        live = await checkNativePermissionStatuses();
      } catch {
        /* use defaults + request result below */
      }
      setPermissionStatuses(applyPermissionRequestResult(live, kind, result));
      if (result === "denied") {
        setPermissionHint(deniedLabel);
      }
    } catch {
      setPermissionHint(deniedLabel);
      refreshPermissionStatuses();
    } finally {
      permissionRequestInFlightRef.current = false;
    }
  };

  const permissionRevokeHint = (status: NativePermissionStatuses[NativePermissionKind]) =>
    isPermissionGranted(status) ? (
      <span
        className="block mt-1 text-[11px] leading-snug text-muted-foreground"
        data-testid="settings-permission-revoke-hint"
      >
        {s.settings_permission_revoke_hint}
      </span>
    ) : null;

  const permissionSublabel = (
    status: NativePermissionStatuses[NativePermissionKind],
    base: string,
  ) => (
    <>
      {base}
      {permissionRevokeHint(status)}
    </>
  );

  const renderPermissionAction = (
    status: NativePermissionStatuses[NativePermissionKind],
    onRequest: () => void,
  ) => {
    if (isPermissionGranted(status)) {
      return (
        <span
          className="shrink-0 text-lg leading-none"
          aria-label="Granted"
          data-testid="settings-permission-granted"
        >
          ✅
        </span>
      );
    }
    return (
      <button
        type="button"
        onClick={onRequest}
        data-testid="settings-permission-allow"
        className="shrink-0 rounded-lg border border-surface-border px-3 py-1.5 text-xs font-semibold text-foreground"
      >
        {s.settings_permission_request}
      </button>
    );
  };
  const { enabled: feedNotificationsEnabled, onCheckedChange: onFeedNotificationsChange } =
    useFeedNotificationsEnabled();
  const [feedDiscoveryRadiusKm, setFeedDiscoveryRadiusKm] = useState<number | null>(5);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone) return;
    void supabase.rpc("get_feed_preferences", { p_user_phone: phone }).then(({ data, error }) => {
      if (error) {
        console.error("get_feed_preferences", error);
        return;
      }
      const raw = (data as { feed_discovery_radius_km?: number | null } | null)
        ?.feed_discovery_radius_km;
      setFeedDiscoveryRadiusKm(raw === null ? null : (raw ?? 5));
    });
  }, [userPhone]);

  const onFeedDiscoveryRadiusChange = async (km: number | null) => {
    const phone = userPhone?.trim();
    if (!phone) return;
    const previous = feedDiscoveryRadiusKm;
    setFeedDiscoveryRadiusKm(km);
    const { error } = await supabase.rpc("set_feed_discovery_radius", {
      p_user_phone: phone,
      p_radius_km: km,
    });
    if (error) {
      console.error("set_feed_discovery_radius", error);
      captureError(error, { scope: "settings.setFeedDiscoveryRadius" });
      setFeedDiscoveryRadiusKm(previous);
      toast.error(s.feed_notifyToggle_saveError);
      return;
    }
    toast.success(s.settings_feedDiscoveryRadiusSaved);
  };

  const [activeTab, setActiveTab] = useState<"settings" | "admin">("settings");
  const [pendingCatOpen, setPendingCatOpen] = useState(false);
  const [pendingLicenseOpen, setPendingLicenseOpen] = useState(false);
  const [pendingAliasOpen, setPendingAliasOpen] = useState(false);
  const [pendingBusinessOpen, setPendingBusinessOpen] = useState(false);
  const [modeConfidenceOpen, setModeConfidenceOpen] = useState(false);
  const [lowRatingsOpen, setLowRatingsOpen] = useState(false);
  const [recommendationsOpen, setRecommendationsOpen] = useState(false);
  const [recommendations, setRecommendations] = useState<
    {
      id: string;
      user_phone: string;
      content: string;
      recommended_vendor_id: string | null;
      recommended_vendor_name: string | null;
      recommended_vendor_phone: string | null;
      reach_radius_km: number | null;
      created_at: string;
      expires_at: string | null;
      admin_contacted_at: string | null;
      admin_dismissed_at: string | null;
      vendor_onboarded: boolean;
    }[]
  >([]);
  const [recommendationsLoading, setRecommendationsLoading] = useState(false);
  const [showRemovedRecs, setShowRemovedRecs] = useState(false);
  const [recActionId, setRecActionId] = useState<string | null>(null);
  const [lowRatings, setLowRatings] = useState<
    {
      id: string;
      vendor_id: string;
      shop_name: string;
      rating: number;
      review_text: string | null;
      user_phone: string | null;
      created_at: string;
    }[]
  >([]);
  const [lowRatingDeletingId, setLowRatingDeletingId] = useState<string | null>(null);
  const [vendorModerationOpen, setVendorModerationOpen] = useState(false);
  const [adminConfigOpen, setAdminConfigOpen] = useState(false);
  const [adminConfigValues, setAdminConfigValues] = useState<Partial<Record<AdminConfigKey, string>>>(
    {},
  );
  const [adminConfigDraft, setAdminConfigDraft] = useState<Partial<Record<AdminConfigKey, string>>>(
    {},
  );
  const [adminConfigDefaults, setAdminConfigDefaults] = useState<
    Partial<Record<AdminConfigKey, string>>
  >({});
  const [adminConfigSaving, setAdminConfigSaving] = useState<AdminConfigKey | null>(null);
  const [adminConfigErrors, setAdminConfigErrors] = useState<Partial<Record<AdminConfigKey, string>>>(
    {},
  );
  const [reviewDeleteDialog, setReviewDeleteDialog] = useState<{
    open: boolean;
    review: (typeof lowRatings)[number] | null;
  }>({ open: false, review: null });
  const [subOverviewOpen, setSubOverviewOpen] = useState(false);
  const [subVendors, setSubVendors] = useState<
    {
      id: string;
      shop_name: string;
      phone: string | null;
      subscription_status: string;
      trial_ends_at: string | null;
      grace_ends_at: string | null;
      subscription_current_period_end: string | null;
      waiveoff_percent: number | null;
      waiveoff_months_remaining: number | null;
    }[]
  >([]);
  const [subLoading, setSubLoading] = useState(false);
  const [subNetworkStatus, setSubNetworkStatus] = useState<"retrying" | "failed" | null>(null);
  const [waivePhone, setWaivePhone] = useState("");
  const [waivePercent, setWaivePercent] = useState("");
  const [waiveMonths, setWaiveMonths] = useState("");
  const [waiveSubmitting, setWaiveSubmitting] = useState(false);
  const waiveSubmitLockRef = useRef(false);
  const [waiveConfirm, setWaiveConfirm] = useState<{
    open: boolean;
    vendor: { id: string; shop_name: string; phone: string | null } | null;
    percent: number;
    months: number;
  }>({ open: false, vendor: null, percent: 0, months: 0 });
  const [rejectCategoryDialog, setRejectCategoryDialog] = useState<{
    open: boolean;
    cat: (typeof pendingCategories)[number] | null;
  }>({ open: false, cat: null });
  const [rejectBusinessDialog, setRejectBusinessDialog] = useState<{
    open: boolean;
    row: (typeof pendingVendorBusinesses)[number] | null;
    reason: string;
  }>({ open: false, row: null, reason: "" });
  const [mergeCategoryDialog, setMergeCategoryDialog] = useState<{
    open: boolean;
    cat: (typeof pendingCategories)[number] | null;
    targetId: string;
  }>({ open: false, cat: null, targetId: "" });
  const [mergeTargetOptions, setMergeTargetOptions] = useState<
    { id: string; label: string; emoji: string | null }[]
  >([]);

  useEffect(() => {
    void (async () => {
      await checkAdminSession();
      setAdminAuthChecked(true);
    })();
  }, [checkAdminSession]);

  // Defense-in-depth: /settings/admin requires session; reveal tab + stay on login if not admin.
  useEffect(() => {
    const onAdminRoute = location.pathname === "/settings/admin";
    if (!onAdminRoute) return;
    setAdminTabRevealed(true);
    setActiveTab("admin");
  }, [location.pathname]);

  useEffect(() => {
    if (!adminAuthChecked) return;
    if (location.pathname !== "/settings/admin") return;
    if (!isAdmin) {
      // Keep admin tab visible so login gate renders; do not show panel.
      setActiveTab("admin");
    }
  }, [adminAuthChecked, isAdmin, location.pathname]);

  // Session drop while viewing admin → force login gate (never leave panel open).
  useEffect(() => {
    if (!adminAuthChecked) return;
    if (activeTab === "admin" && !isAdmin) {
      setAdminTabRevealed(true);
    }
  }, [adminAuthChecked, activeTab, isAdmin]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void checkAdminSession();
    });
    return () => subscription.unsubscribe();
  }, [checkAdminSession]);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase
        .from("app_config")
        .select("value")
        .eq("key", "referral_enabled")
        .maybeSingle();
      const raw = data?.value?.trim().toLowerCase();
      if (raw === "false" || raw === "0") setReferEarnVisible(false);
      else setReferEarnVisible(true);
    })();
  }, []);

  useEffect(() => {
    if (isAdmin && adminTabRevealed) setActiveTab("admin");
  }, [isAdmin, adminTabRevealed]);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone) {
      setUserTrust(null);
      setTrustLoadFailed(false);
      return;
    }
    void (async () => {
      const { data, error } = await supabase.rpc("lookup_user_by_phone", { p_phone: phone });
      if (error) {
        captureError(error, { scope: "settings.loadUserTrust" });
        console.error("loadUserTrust", error);
        setUserTrust(null);
        setTrustLoadFailed(true);
        return;
      }
      setTrustLoadFailed(false);
      const row = data?.[0];
      setUserTrust(
        row
          ? {
              trust_score: row.trust_score,
              warn_count: row.warn_count,
              is_banned: row.is_banned,
            }
          : null,
      );
    })();
  }, [userPhone]);

  const accountStanding = useMemo(() => {
    // RPC failure: show "unavailable", not a false-good standing.
    if (trustLoadFailed) {
      return { tone: "unavailable" as const, label: s.trust_status_unavailable };
    }
    if (!userTrust) {
      return { tone: "good" as const, label: s.trust_status_good };
    }
    if (userTrust.is_banned) {
      return { tone: "banned" as const, label: s.trust_status_banned };
    }
    const score = userTrust.trust_score ?? 75;
    const warns = userTrust.warn_count ?? 0;
    if (score < 25 || warns >= 3) {
      return { tone: "complaints" as const, label: s.trust_status_complaints };
    }
    if (score >= 25 && score <= 74) {
      return { tone: "fair" as const, label: s.trust_status_fair };
    }
    return { tone: "good" as const, label: s.trust_status_good };
  }, [userTrust, trustLoadFailed, s]);
  const [vendorLoadFailed, setVendorLoadFailed] = useState(false);
  const loadVendorOwn = useCallback(async () => {
    if (!vendorId) return;
    setVendorLoadFailed(false);
    const phone = getUserPhone()?.trim();
    if (!phone) {
      console.error("Failed to load vendor: phone required");
      setVendorLoadFailed(true);
      return;
    }
    const { data, error } = await fetchVendorOwn(vendorId, phone);
    if (error) {
      captureError(error, { scope: "settings.fetchVendorOwn", vendorId });
      console.error("Failed to load vendor:", error.message);
      setVendorLoadFailed(true);
      return;
    }
    if (data) setVendor(data);
  }, [vendorId]);

  useEffect(() => {
    void loadVendorOwn();
  }, [loadVendorOwn]);

  // Batch-fetch referral credits for Preferences (menu/offers live under My Business).
  useEffect(() => {
    if (!vendorId) {
      setVendorExtras(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const vendorPhoneForCredits = getUserPhone()?.trim();
      const creditsRes = vendorPhoneForCredits
        ? await supabase.rpc("get_vendor_credits", {
            p_vendor_id: vendorId,
            p_vendor_phone: vendorPhoneForCredits,
          })
        : { data: [], error: null };

      if (cancelled) return;
      if (creditsRes.error) {
        captureError(creditsRes.error, { scope: "settings.vendorExtras.credits", vendorId });
        console.error("vendorExtras credits", creditsRes.error);
      }

      let total = 0;
      let pending = 0;
      for (const row of creditsRes.data ?? []) {
        const amt = Number(row.amount) || 0;
        total += amt;
        if (!row.disbursed) pending += amt;
      }
      setVendorExtras({
        referralCredits: creditsRes.error
          ? { total: 0, pending: 0, failed: true }
          : { total, pending },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  useEffect(() => {
    const phone = userPhone?.trim();
    if (!phone || !isVendor) {
      setVendorDeletionRequestedAt(null);
      return;
    }
    void (async () => {
      const { data, error } = await supabase.rpc("get_vendor_deletion_status", {
        p_phone: phone,
      });
      if (error) {
        console.error("loadVendorDeletionRequestedAt", error);
        return;
      }
      const row = Array.isArray(data) ? data[0] : null;
      setVendorDeletionRequestedAt(row?.deletion_requested_at ?? null);
    })();
  }, [userPhone, isVendor]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // Permission badges only — do not navigate, reload, or remount routes on resume.
    const refreshIfIdle = () => {
      if (permissionRequestInFlightRef.current) return;
      refreshPermissionStatuses();
    };

    refreshIfIdle();

    let listener: { remove: () => Promise<void> } | undefined;
    void App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) refreshIfIdle();
    }).then((handle) => {
      listener = handle;
    });

    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshIfIdle();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      void listener?.remove();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshPermissionStatuses]);

  // Re-read OS permissions whenever the Device section is opened (post Clear Data / new user).
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !deviceOpen) return;
    if (permissionRequestInFlightRef.current) return;
    refreshPermissionStatuses();
  }, [deviceOpen, refreshPermissionStatuses]);

  useEffect(() => {
    if (!isAdmin) return;
    const load = async () => {
      const { data, error } = await supabase.rpc("get_admin_dashboard_stats", {
        p_admin_phone: adminRpcLabel(),
      });
      if (error) {
        console.error("get_admin_dashboard_stats", error);
        return;
      }
      if (!data || typeof data !== "object") return;

      const stats = data as Record<string, number>;
      setAdminStats({
        totalOrders: Number(stats.total_orders ?? 0),
        ordersToday: Number(stats.orders_today ?? 0),
        ordersThisWeek: Number(stats.orders_this_week ?? 0),
        totalVendors: Number(stats.total_vendors ?? 0),
        totalCustomers: Number(stats.total_customers ?? 0),
        activeVendorsToday: Number(stats.active_vendors_today ?? 0),
        newVendorsThisWeek: Number(stats.new_vendors_this_week ?? 0),
        unverifiedVendors: Number(stats.unverified_vendors ?? 0),
        greenPendingVendors: Number(stats.green_pending_vendors ?? 0),
        stuckOrders: Number(stats.stuck_orders ?? 0),
        avgVendorRating: Number(stats.avg_vendor_rating ?? 0),
        riskyUsers: Number(stats.risky_users ?? 0),
        totalReferrals: Number(stats.total_referrals ?? 0),
      });
    };
    void load();
  }, [isAdmin]);

  const loadAdminConfig = async () => {
    const { data, error } = await supabase
      .from("app_config")
      .select("key, value, default_value")
      .in("key", [...ADMIN_CONFIG_WHITELIST]);
    if (error) {
      console.error("loadAdminConfig", error);
      return;
    }
    const values: Partial<Record<AdminConfigKey, string>> = {};
    const defaults: Partial<Record<AdminConfigKey, string>> = {};
    for (const key of ADMIN_CONFIG_WHITELIST) {
      const row = data?.find((r) => r.key === key);
      const dbDefault =
        row?.default_value != null ? String(row.default_value).trim() : "";
      // Prefer DB default_value; fall back to client map so missing rows never
      // leave a blank/ambiguous field in the admin UI.
      const defaultValue = dbDefault || ADMIN_CONFIG_FALLBACK_DEFAULTS[key];
      defaults[key] = defaultValue;
      const liveValue = row?.value != null ? String(row.value).trim() : "";
      values[key] = liveValue || defaultValue;
    }
    setAdminConfigDefaults(defaults);
    setAdminConfigValues(values);
    setAdminConfigDraft(values);
  };

  useEffect(() => {
    if (!isAdmin || !adminConfigOpen) return;
    void loadAdminConfig();
  }, [isAdmin, adminConfigOpen]);

  const enrichVendorsWithMeta = async (
    vendors: Array<{
      id: string;
      name: string;
      shop_name: string;
      category: string;
      service_mode: string | null;
      vendor_type: string | null;
      phone: string;
      is_manual_verified: boolean;
      is_active: boolean;
      is_banned: boolean;
      ban_reason: string | null;
      deletion_requested_at: string | null;
      shop_photo_url: string | null;
      upi_id: string | null;
      latitude: number | null;
      longitude: number | null;
      referral_code: string | null;
      last_updated: string | null;
      gps_match_distance: number | null;
      upi_verified: boolean;
    }>,
  ): Promise<AdminVendorListRow[]> => {
    if (!vendors.length) return [];

    const vendorIds = vendors.map((v) => v.id);
    const [vcData, verifications] = await Promise.all([
      fetchByIdChunks("loadVendorList/vendor_categories", vendorIds, (chunk) =>
        supabase
          .from("vendor_categories")
          .select(
            "vendor_id, category_id, is_primary, service_mode, shop_photo_url, gps_match_distance, location_accuracy, photo_accuracy, verification_status, is_manual_verified, latitude, longitude, upi_id, categories(label, emoji)",
          )
          .in("vendor_id", chunk)
          .eq("status", "approved"),
      ),
      fetchByIdChunks("loadVendorList/vendor_verification", vendorIds, (chunk) =>
        supabase
          .from("vendor_verification")
          .select("vendor_id, check_type, status, is_latest")
          .in("vendor_id", chunk)
          .eq("is_latest", true),
      ),
    ]);

    const categoriesMap = buildAdminVendorCategoriesMap(vcData);

    const businessRows: BusinessLocationRow[] = [];
    const trustKeys: Array<{ vendorId: string; categoryId: string }> = [];
    for (const [vendorId, cats] of categoriesMap) {
      for (const c of cats) {
        if (!c.category_id) continue;
        businessRows.push({
          vendor_id: vendorId,
          category_id: c.category_id,
          shop_photo_url: c.shop_photo_url,
          gps_match_distance: c.gps_match_distance,
          location_accuracy: c.location_accuracy,
          photo_accuracy: c.photo_accuracy,
          verification_status: c.verification_status,
        });
      }
      const primary = cats.find((c) => c.is_primary) ?? cats[0];
      if (primary?.category_id) {
        trustKeys.push({ vendorId, categoryId: primary.category_id });
      }
    }
    const trustByVendorCategory = computeTrustLevelsByVendorCategory(
      trustKeys,
      verifications as VendorVerificationRow[],
      businessRows,
    );

    const verificationsByVendor = new Map<string, VendorVerificationRow[]>();
    for (const row of verifications) {
      const list = verificationsByVendor.get(row.vendor_id) ?? [];
      list.push(row);
      verificationsByVendor.set(row.vendor_id, list);
    }

    return vendors.map((v) => {
      let categories = categoriesMap.get(v.id) ?? [];
      if (categories.length === 0 && v.category) {
        categories = [
          {
            category_id: null,
            label: v.category,
            emoji: "✨",
            service_mode: v.service_mode ?? "help",
            is_primary: true,
            shop_photo_url: v.shop_photo_url,
            gps_match_distance: v.gps_match_distance,
            location_accuracy: null,
            photo_accuracy: null,
            verification_status: null,
            is_manual_verified: v.is_manual_verified,
            latitude: null,
            longitude: null,
            upi_id: null,
          },
        ];
      }
      const primaryCat = categories.find((c) => c.is_primary) ?? categories[0];
      const trustLevel: TrustLevel =
        primaryCat?.category_id != null
          ? (trustByVendorCategory.get(
              vendorCategoryTrustKey(v.id, primaryCat.category_id),
            ) ?? "Unverified")
          : "Unverified";
      return {
        ...v,
        vendor_type: v.vendor_type as Vendor["vendor_type"],
        categories,
        trustLevel,
        verifications: verificationsByVendor.get(v.id) ?? [],
      };
    });
  };

  const loadVendorList = async (opts?: { append?: boolean }): Promise<AdminVendorListRow[]> => {
    const append = opts?.append ?? false;
    setVendorListLoading(true);
    try {
      const search = vendorSearch.trim().replace(/,/g, "");
      const offset = append ? vendorListRef.current.length : 0;

      let query = supabase
        .from("vendors")
        .select(VENDOR_LIST_SELECT, { count: "exact" })
        .order("is_manual_verified", { ascending: true })
        .order("shop_name");

      if (search.length >= 2) {
        const pattern = `%${search}%`;
        query = query.or(
          `shop_name.ilike.${pattern},name.ilike.${pattern},phone.ilike.${pattern}`,
        );
      } else if (vendorListFilter === "green_ready") {
        // Ready for admin review: green_pending or pending_location_review.
        const { data: catRows } = await supabase
          .from("vendor_categories")
          .select("vendor_id")
          .in("verification_status", ["green_pending", "pending_location_review"])
          .eq("is_manual_verified", false)
          .limit(500);
        const catVendorIds = [
          ...new Set(((catRows ?? []) as { vendor_id: string }[]).map((r) => r.vendor_id)),
        ];
        query = query.or(
          catVendorIds.length > 0
            ? `verification_status.eq.green_pending,id.in.(${catVendorIds.join(",")})`
            : "verification_status.eq.green_pending",
        );
      } else if (vendorListFilter === "attention") {
        query = query.or("is_manual_verified.eq.false,is_banned.eq.true");
      }

      const rangeEnd = offset + ADMIN_VENDOR_LIST_PAGE_SIZE - 1;
      const { data: vendors, error, count } = await query.range(offset, rangeEnd);

      if (error) {
        console.error("loadVendorList", error);
        if (!append) setVendorList([]);
        setVendorListHasMore(false);
        return [];
      }

      const rows = vendors ?? [];
      const merged = await enrichVendorsWithMeta(rows);
      let nextList: AdminVendorListRow[] = merged;
      setVendorList((prev) => {
        nextList = append ? [...prev, ...merged] : merged;
        return nextList;
      });

      const total = count ?? nextList.length;
      const loaded = offset + rows.length;
      const capped = loaded >= ADMIN_QUERY_MAX_ROWS;
      const hasMore =
        !capped && loaded < total && rows.length === ADMIN_VENDOR_LIST_PAGE_SIZE;
      setVendorListHasMore(hasMore);
      if (capped) {
        warnIfQueryTruncated("loadVendorList", loaded, ADMIN_QUERY_MAX_ROWS);
      }
      return nextList;
    } finally {
      setVendorListLoading(false);
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    const delay = vendorSearch.trim().length >= 2 ? 300 : 0;
    const timer = window.setTimeout(() => {
      void loadVendorList();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [isAdmin, vendorListFilter, vendorSearch]);

  const loadPendingCategories = async () => {
    let rows: Array<{
      id: string;
      label: string;
      emoji: string;
      service_mode: string;
      ai_confidence: string | null;
      ai_confidence_score: number | null;
      ai_reasoning: string | null;
      ai_service_mode_reasoning: string | null;
      proposed_aliases: string[] | null;
      overlap_category_label: string | null;
      overlap_reasoning: string | null;
      suggestion_count: number | null;
      suggested_by_vendor_id: string | null;
      status: string;
      pending_review: boolean;
      license_type: string | null;
      license_confidence_score: number | null;
      license_reasoning: string | null;
      license_review_status: string | null;
    }> = [];
    try {
      rows = await fetchAllPages("loadPendingCategories", (from, to) =>
        supabase
          .from("categories")
          .select(
            "id, label, emoji, service_mode, ai_confidence, ai_confidence_score, ai_reasoning, ai_service_mode_reasoning, proposed_aliases, overlap_category_label, overlap_reasoning, suggestion_count, suggested_by_vendor_id, status, pending_review, license_type, license_confidence_score, license_reasoning, license_review_status",
          )
          .or("status.eq.pending_review,and(pending_review.eq.true,is_active.eq.false)")
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (error) {
      console.error("loadPendingCategories", error);
      setPendingCategories([]);
      return;
    }

    const vendorIds = [
      ...new Set(
        rows
          .map((r) => r.suggested_by_vendor_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const vendorNameById = new Map<string, string>();
    if (vendorIds.length > 0) {
      const vendors = await fetchByIdChunks<{ id: string; shop_name: string | null }>(
        "loadPendingCategories/vendors",
        vendorIds,
        (chunk) => supabase.from("vendors").select("id, shop_name").in("id", chunk),
      );
      for (const v of vendors) {
        vendorNameById.set(v.id, v.shop_name ?? "Vendor");
      }
    }

    setPendingCategories(
      rows.map((cat) => ({
        id: cat.id,
        label: cat.label,
        emoji: cat.emoji,
        service_mode: cat.service_mode,
        ai_confidence: cat.ai_confidence,
        ai_confidence_score: cat.ai_confidence_score,
        ai_reasoning: cat.ai_reasoning,
        ai_service_mode_reasoning: cat.ai_service_mode_reasoning,
        proposed_aliases: Array.isArray(cat.proposed_aliases)
          ? cat.proposed_aliases.filter((a) => typeof a === "string" && a.trim())
          : [],
        overlap_category_label: cat.overlap_category_label,
        overlap_reasoning: cat.overlap_reasoning,
        suggestion_count:
          cat.suggestion_count != null && Number.isFinite(cat.suggestion_count)
            ? Number(cat.suggestion_count)
            : 0,
        suggested_by_vendor_id: cat.suggested_by_vendor_id,
        suggested_vendor_name: cat.suggested_by_vendor_id
          ? vendorNameById.get(cat.suggested_by_vendor_id) ?? null
          : null,
        license_type: cat.license_type,
        license_confidence_score: cat.license_confidence_score,
        license_reasoning: cat.license_reasoning,
        license_review_status: cat.license_review_status,
      })),
    );
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadPendingCategories();
  }, [isAdmin]);

  const loadPendingLicenses = async () => {
    const { data, error } = await supabase.rpc("admin_list_pending_category_licenses");
    if (error) {
      console.error("loadPendingLicenses", error);
      setPendingLicenses([]);
      return;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      label: string;
      emoji: string | null;
      license_type: string | null;
      license_confidence_score: number | null;
      license_reasoning: string | null;
      is_active: boolean;
      status: string | null;
    }>;
    setPendingLicenses(rows);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadPendingLicenses();
  }, [isAdmin]);

  const loadPendingAliases = async () => {
    let rows: Array<{
      id: string;
      term: string;
      confidence: number | null;
      ai_reasoning: string | null;
      source: string;
      category_id: string;
      suggested_by_vendor_id: string | null;
      categories: { label: string; emoji: string } | { label: string; emoji: string }[] | null;
    }> = [];
    try {
      rows = await fetchAllPages("loadPendingAliases", (from, to) =>
        supabase
          .from("category_search_terms")
          .select(
            "id, term, confidence, ai_reasoning, source, category_id, suggested_by_vendor_id, categories!inner(label, emoji)",
          )
          .eq("status", "pending_review")
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (error) {
      console.error("loadPendingAliases", error);
      setPendingAliases([]);
      return;
    }

    const vendorIds = [
      ...new Set(
        rows
          .map((r) => r.suggested_by_vendor_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    const vendorNameById = new Map<string, string>();
    if (vendorIds.length > 0) {
      const vendors = await fetchByIdChunks<{ id: string; shop_name: string | null }>(
        "loadPendingAliases/vendors",
        vendorIds,
        (chunk) => supabase.from("vendors").select("id, shop_name").in("id", chunk),
      );
      for (const v of vendors) {
        vendorNameById.set(v.id, v.shop_name ?? "Vendor");
      }
    }

    setPendingAliases(
      rows.map((row) => {
        const cats = row.categories;
        const cat = Array.isArray(cats) ? cats[0] : cats;
        return {
          id: row.id,
          term: row.term,
          confidence: row.confidence,
          ai_reasoning: row.ai_reasoning,
          source: row.source,
          category_id: row.category_id,
          category_label: cat?.label ?? "Category",
          category_emoji: cat?.emoji ?? "✨",
          suggested_by_vendor_id: row.suggested_by_vendor_id,
          suggested_vendor_name: row.suggested_by_vendor_id
            ? vendorNameById.get(row.suggested_by_vendor_id) ?? null
            : null,
        };
      }),
    );
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadPendingAliases();
  }, [isAdmin]);

  const loadPendingVendorBusinesses = async () => {
    const { data, error } = await supabase.rpc("admin_list_pending_vendor_businesses");
    if (error) {
      console.error("loadPendingVendorBusinesses", error);
      setPendingVendorBusinesses([]);
      return;
    }
    const rows = (data ?? []) as Array<{
      vendor_category_id: string;
      vendor_id: string;
      shop_name: string | null;
      vendor_phone: string | null;
      vendor_name: string | null;
      category_id: string;
      category_label: string;
      category_emoji: string | null;
      brand_name: string | null;
      created_at: string;
      approved_businesses: unknown;
    }>;
    setPendingVendorBusinesses(
      rows.map((r) => ({
        ...r,
        approved_businesses: Array.isArray(r.approved_businesses)
          ? (r.approved_businesses as (typeof pendingVendorBusinesses)[number]["approved_businesses"])
          : [],
      })),
    );
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadPendingVendorBusinesses();
  }, [isAdmin]);

  const loadModeConfidenceReviews = async () => {
    let rows: Array<{
      id: string;
      category_id: string;
      current_default_mode: string;
      proposed_mode: string;
      default_mode_vendor_count: number;
      proposed_mode_vendor_count: number;
      created_at: string;
      categories: { label: string; emoji: string } | { label: string; emoji: string }[] | null;
    }> = [];
    try {
      rows = await fetchAllPages("loadModeConfidenceReviews", (from, to) =>
        supabase
          .from("category_mode_reviews")
          .select(
            "id, category_id, current_default_mode, proposed_mode, default_mode_vendor_count, proposed_mode_vendor_count, created_at, categories!inner(label, emoji)",
          )
          .eq("status", "pending_review")
          .order("created_at", { ascending: false })
          .range(from, to),
      );
    } catch (error) {
      console.error("loadModeConfidenceReviews", error);
      setModeConfidenceReviews([]);
      return;
    }

    setModeConfidenceReviews(
      rows.map((row) => {
        const cats = row.categories;
        const cat = Array.isArray(cats) ? cats[0] : cats;
        return {
          id: row.id,
          category_id: row.category_id,
          category_label: cat?.label ?? "Category",
          category_emoji: cat?.emoji ?? "✨",
          current_default_mode: row.current_default_mode,
          proposed_mode: row.proposed_mode,
          default_mode_vendor_count: Number(row.default_mode_vendor_count) || 0,
          proposed_mode_vendor_count: Number(row.proposed_mode_vendor_count) || 0,
          created_at: row.created_at,
        };
      }),
    );
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadModeConfidenceReviews();
  }, [isAdmin]);

  const loadLowRatings = async () => {
    const rows = await loadAdminLowRatings(s.radar_vendor_fallback);
    setLowRatings(rows);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadLowRatings();
  }, [isAdmin]);

  const loadRecommendations = async (includeDismissed?: boolean) => {
    setRecommendationsLoading(true);
    const { data, error } = await supabase.rpc("get_recommendations_for_admin", {
      p_admin_phone: adminRpcLabel(),
      p_include_dismissed: includeDismissed ?? showRemovedRecs,
    });
    setRecommendationsLoading(false);
    if (error) {
      console.error("get_recommendations_for_admin", error);
      setRecommendations([]);
      return;
    }
    setRecommendations(Array.isArray(data) ? (data as typeof recommendations) : []);
  };

  useEffect(() => {
    if (!isAdmin || !recommendationsOpen) return;
    void loadRecommendations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, recommendationsOpen, showRemovedRecs]);

  const markRecommendationContacted = async (
    rec: (typeof recommendations)[number],
    contacted: boolean,
  ) => {
    setRecActionId(rec.id);
    const { error } = await supabase.rpc("admin_mark_recommendation_contacted", {
      p_admin_phone: adminRpcLabel(),
      p_post_id: rec.id,
      p_contacted: contacted,
    });
    setRecActionId(null);
    if (error) {
      console.error("markRecommendationContacted", error);
      toast.error("Update failed: " + error.message);
      return;
    }
    setRecommendations((prev) =>
      prev.map((r) =>
        r.id === rec.id
          ? { ...r, admin_contacted_at: contacted ? new Date().toISOString() : null }
          : r,
      ),
    );
  };

  const dismissRecommendation = async (rec: (typeof recommendations)[number]) => {
    setRecActionId(rec.id);
    const { error } = await supabase.rpc("admin_dismiss_recommendation", {
      p_admin_phone: adminRpcLabel(),
      p_post_id: rec.id,
    });
    setRecActionId(null);
    if (error) {
      console.error("dismissRecommendation", error);
      toast.error("Update failed: " + error.message);
      return;
    }
    await loadRecommendations();
  };

  const restoreRecommendation = async (rec: (typeof recommendations)[number]) => {
    setRecActionId(rec.id);
    const { error } = await supabase.rpc("admin_restore_recommendation", {
      p_admin_phone: adminRpcLabel(),
      p_post_id: rec.id,
    });
    setRecActionId(null);
    if (error) {
      console.error("restoreRecommendation", error);
      toast.error("Update failed: " + error.message);
      return;
    }
    await loadRecommendations();
  };

  const deleteLowRating = async (row: (typeof lowRatings)[number]) => {
    setLowRatingDeletingId(row.id);
    setLowRatings((prev) => prev.filter((r) => r.id !== row.id));

    const result = await deleteAdminLowRating(row, adminRpcLabel());
    if (result.ok === false) {
      console.error("deleteLowRating", result.error);
      toast.error(result.error.message);
      setLowRatingDeletingId(null);
      void loadLowRatings();
      return;
    }

    logAdminAction(
      "delete_review",
      "vendor",
      row.vendor_id,
      `review_id:${row.id} rating:${row.rating}`,
      adminAuditLabel(),
    );

    setLowRatingDeletingId(null);
  };

  const loadFlaggedUsers = async () => {
    // Direct .from("users") is blocked by users_owner RLS for other phones;
    // admin_list_flagged_users (SECURITY DEFINER, is_admin_session gate)
    // returns the flagged set for admin sessions.
    const { data, error } = await supabase.rpc("admin_list_flagged_users", {
      p_admin_phone: adminRpcLabel(),
    });
    if (error) {
      console.error("loadFlaggedUsers", error);
      setFlaggedUsers([]);
      return;
    }
    setFlaggedUsers(data ?? []);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void loadFlaggedUsers();
  }, [isAdmin]);

  const trustScoreClass = (score: number) => {
    if (score >= 75) return "text-green-500";
    if (score >= 50) return "text-amber-500";
    return "text-red-500";
  };

  const maskPhoneLast4 = (phone: string): string => {
    const digits = phone.replace(/\D/g, "");
    return `••••${digits.slice(-4)}`;
  };

  const loadSubVendors = async () => {
    setSubLoading(true);
    setSubNetworkStatus(null);
    try {
      const { data, error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase
              .from("vendors")
              .select(
                "id, shop_name, phone, subscription_status, trial_ends_at, grace_ends_at, subscription_current_period_end, waiveoff_percent, waiveoff_months_remaining",
              )
              .in("subscription_status", ["grace", "expired", "cancelled"])
              .order("grace_ends_at", { ascending: true, nullsFirst: false }),
          ),
        {
          onRetrying: () => setSubNetworkStatus("retrying"),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      if (error) {
        console.error("loadSubVendors", error);
        toast.error(error.message);
        return;
      }
      setSubVendors(
        (data ?? []).map((row) => ({
          id: row.id as string,
          shop_name: (row.shop_name as string | null)?.trim() || "Vendor",
          phone: (row.phone as string | null) ?? null,
          subscription_status: (row.subscription_status as string | null) ?? "trial",
          trial_ends_at: (row.trial_ends_at as string | null) ?? null,
          grace_ends_at: (row.grace_ends_at as string | null) ?? null,
          subscription_current_period_end:
            (row.subscription_current_period_end as string | null) ?? null,
          waiveoff_percent: (row.waiveoff_percent as number | null) ?? null,
          waiveoff_months_remaining:
            (row.waiveoff_months_remaining as number | null) ?? null,
        })),
      );
      setSubNetworkStatus(null);
    } catch (err) {
      if (err instanceof NetworkExhaustedError) {
        setSubNetworkStatus("failed");
      } else {
        throw err;
      }
    } finally {
      setSubLoading(false);
    }
  };

  const formatAdminDate = (value: string | null): string => {
    if (!value) return "—";
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };

  const daysAgo = (value: string | null): string => {
    if (!value) return "—";
    const d = new Date(value).getTime();
    if (!Number.isFinite(d)) return "—";
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    if (diffDays <= 0) return "today";
    if (diffDays === 1) return "1 day ago";
    return `${diffDays} days ago`;
  };

  const notifyCategoryVendor = async (
    cat: (typeof pendingCategories)[number],
    kind: "approved" | "rejected",
  ) => {
    if (!cat.suggested_by_vendor_id) return;
    const title =
      kind === "approved" ? s.category_approved_title : s.category_rejected_title;
    const bodyTemplate =
      kind === "approved" ? s.category_approved_body : s.category_rejected_body;
    const body = bodyTemplate.replace("{label}", cat.label);
    void invokeNotifyVendor({
      vendor_id: cat.suggested_by_vendor_id,
      notification_title: title,
      message: body,
      type: kind === "approved" ? "category_approved" : "category_rejected",
      route: "settings",
      route_params: {
        vendor_id: cat.suggested_by_vendor_id,
        category_id: cat.id,
      },
    });
  };

  const notifyAccountRestored = (
    phone: string,
    route: "vendor" | "settings",
    vendorId?: string,
  ) => {
    const title = s.account_restored_title;
    const body = s.account_restored_body;
    if (route === "vendor" && vendorId) {
      void invokeNotifyVendor({
        vendor_id: vendorId,
        notification_title: title,
        message: body,
        type: "account_restored",
      });
    } else {
      void invokeNotifyUser({
        user_phone: phone,
        title,
        body,
        type: "account_restored",
      });
    }
  };

  const saveAdminConfigKey = async (key: AdminConfigKey, overrideValue?: string) => {
    const configType = getAdminConfigType(key);
    const raw = overrideValue ?? adminConfigDraft[key] ?? adminConfigValues[key] ?? "";
    const newValue = configType === "boolean" ? (parseAdminConfigBoolean(raw) ? "true" : "false") : raw.trim();

    if (configType === "number") {
      if (newValue === "" || Number.isNaN(Number(newValue))) {
        setAdminConfigErrors((prev) => ({ ...prev, [key]: "Must be a number" }));
        return;
      }
    }

    setAdminConfigErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setAdminConfigSaving(key);
    const { error } = await supabase.rpc("admin_update_app_config", {
      p_admin_phone: adminRpcLabel(),
      p_key: key,
      p_value: newValue,
    });
    setAdminConfigSaving(null);
    if (error) {
      console.error("saveAdminConfigKey", error);
      toast.error(error.message);
      return;
    }
    setAdminConfigValues((prev) => ({ ...prev, [key]: newValue }));
    setAdminConfigDraft((prev) => ({ ...prev, [key]: newValue }));
    if (key === "referral_enabled") {
      setReferEarnVisible(parseAdminConfigBoolean(newValue));
    }
    logAdminAction("update_config", "config", key, `${key} = ${newValue}`, adminAuditLabel());
    toast.success(s.admin_config_updated);
  };

  const warnFlaggedUser = async (phone: string) => {
    if (adminUserActionLockRef.current.has(phone)) return;
    adminUserActionLockRef.current.add(phone);
    setFlaggedAction(phone);

    try {
      const result = await runWarnFlaggedUser(
        phone,
        {
          localizationEnabled: config.localizationEnabled,
          langHindiEnabled: config.langHindiEnabled,
          langMarathiEnabled: config.langMarathiEnabled,
        },
        adminAuditLabel(),
      );

      if (result.ok === false) {
        console.error("warnFlaggedUser", result.error);
        toast.error("Warning sent but count not saved");
        return;
      }
      toast.success("Warning sent");
      await loadFlaggedUsers();
    } finally {
      adminUserActionLockRef.current.delete(phone);
      setFlaggedAction((current) => (current === phone ? null : current));
    }
  };

  const confirmBanVendor = async () => {
    const v = vendorBanDialog.vendor;
    if (!v || !vendorBanReason.trim()) return;
    if (adminVendorActionLockRef.current.has(v.id)) return;
    adminVendorActionLockRef.current.add(v.id);
    setVendorBanAction(v.id);

    try {
      const { error } = await supabase.rpc("admin_ban_vendor", {
        p_admin_phone: adminRpcLabel(),
        p_vendor_id: v.id,
        p_reason: vendorBanReason.trim(),
      });
      if (error) {
        console.error("confirmBanVendor", error);
        toast.error("Failed to ban vendor");
        return;
      }
      const title = s.admin_vendor_banned_title;
      const body = s.admin_vendor_banned_body;
      void invokeNotifyVendor({
        vendor_id: v.id,
        notification_title: title,
        message: body,
        type: "account_banned",
      });
      logAdminAction("ban_vendor", "vendor", v.id, vendorBanReason.trim(), adminAuditLabel());
      toast.success("Vendor banned");
      setVendorBanDialog({ open: false, vendor: null });
      setVendorBanReason("");
      await loadVendorList();
    } finally {
      adminVendorActionLockRef.current.delete(v.id);
      setVendorBanAction((current) => (current === v.id ? null : current));
    }
  };

  const unbanVendor = async (vendorId: string) => {
    if (adminVendorActionLockRef.current.has(vendorId)) return;
    adminVendorActionLockRef.current.add(vendorId);
    setVendorBanAction(vendorId);

    try {
      const vendorRow = vendorList.find((v) => v.id === vendorId);
      const { error } = await supabase.rpc("admin_unban_vendor", {
        p_admin_phone: adminRpcLabel(),
        p_vendor_id: vendorId,
      });
      if (error) {
        console.error("unbanVendor", error);
        toast.error("Failed to unban vendor");
        return;
      }
      const phone = vendorRow?.phone?.trim();
      if (phone) {
        notifyAccountRestored(phone, "vendor", vendorId);
      }
      logAdminAction("unban_vendor", "vendor", vendorId, null, adminAuditLabel());
      toast.success("Vendor unbanned");
      await loadVendorList();
    } finally {
      adminVendorActionLockRef.current.delete(vendorId);
      setVendorBanAction((current) => (current === vendorId ? null : current));
    }
  };

  const confirmForceClearDeletion = async () => {
    const v = vendorClearDeletionDialog.vendor;
    if (!v || !vendorClearDeletionReason.trim()) return;
    if (adminVendorActionLockRef.current.has(v.id)) return;
    adminVendorActionLockRef.current.add(v.id);
    setVendorBanAction(v.id);

    try {
      const { error } = await supabase.rpc("admin_force_clear_deletion", {
        p_vendor_id: v.id,
        p_notes: vendorClearDeletionReason.trim(),
      });
      if (error) {
        console.error("confirmForceClearDeletion", error);
        toast.error("Failed to clear deletion");
        return;
      }
      logAdminAction(
        "force_clear_deletion",
        "vendor",
        v.id,
        vendorClearDeletionReason.trim(),
        adminAuditLabel(),
      );
      toast.success("Deletion flag cleared");
      setVendorClearDeletionDialog({ open: false, vendor: null });
      setVendorClearDeletionReason("");
      await loadVendorList();
    } finally {
      adminVendorActionLockRef.current.delete(v.id);
      setVendorBanAction((current) => (current === v.id ? null : current));
    }
  };

  const confirmBanUser = async () => {
    if (!banDialog.phone || !banReason.trim()) return;
    const bannedPhone = banDialog.phone;
    if (adminUserActionLockRef.current.has(bannedPhone)) return;
    adminUserActionLockRef.current.add(bannedPhone);
    setFlaggedAction(bannedPhone);

    try {
      const { error } = await supabase.rpc("admin_ban_user", {
        p_admin_phone: adminRpcLabel(),
        p_user_phone: bannedPhone,
        p_reason: banReason.trim(),
      });
      if (error) {
        console.error("confirmBanUser", error);
        toast.error("Failed to ban user: " + error.message);
        return;
      }
      const reason = banReason.trim();
      void invokeNotifyUser({
        user_phone: bannedPhone,
        title: s.user_banned_title,
        body: s.user_banned_body,
        type: "account_banned",
      });
      logAdminAction("ban_user", "user", bannedPhone, reason, adminAuditLabel());
      toast.success("User banned");
      setBanDialog({ open: false, phone: null });
      setBanReason("");
      await loadFlaggedUsers();
    } finally {
      adminUserActionLockRef.current.delete(bannedPhone);
      setFlaggedAction((current) => (current === bannedPhone ? null : current));
    }
  };

  const unbanFlaggedUser = async (phone: string) => {
    setFlaggedAction(phone);
    const { error } = await supabase.rpc("admin_unban_user", {
      p_admin_phone: adminRpcLabel(),
      p_user_phone: phone,
    });
    setFlaggedAction(null);
    if (error) {
      console.error("unbanFlaggedUser", error);
      toast.error("Failed to unban user: " + error.message);
      return;
    }
    notifyAccountRestored(phone, "settings");
    logAdminAction("unban_user", "user", phone, null, adminAuditLabel());
    toast.success("User unbanned");
    await loadFlaggedUsers();
  };

  const confirmApplyWaiveoff = async () => {
    const info = waiveConfirm;
    if (!info.vendor) return;
    if (waiveSubmitLockRef.current) return;

    waiveSubmitLockRef.current = true;
    setWaiveConfirm({ open: false, vendor: null, percent: 0, months: 0 });
    setWaiveSubmitting(true);

    try {
      const result = await runApplyVendorWaiveoff(
        { id: info.vendor.id, phone: info.vendor.phone },
        info.percent,
        info.months,
        {
          localizationEnabled: config.localizationEnabled,
          langHindiEnabled: config.langHindiEnabled,
          langMarathiEnabled: config.langMarathiEnabled,
        },
        adminAuditLabel(),
      );
      if (result.ok === false) {
        console.error("applyWaiveoff", result.error);
        toast.error(result.error || "Failed to apply waive-off");
        return;
      }
      toast.success(s.admin_sub_waiveoff_applied);
      setWaivePhone("");
      setWaivePercent("");
      setWaiveMonths("");
      void loadSubVendors();
    } finally {
      waiveSubmitLockRef.current = false;
      setWaiveSubmitting(false);
    }
  };

  const approvePendingCategory = async (cat: (typeof pendingCategories)[number]) => {
    setPendingAction(cat.id);
    const { error } = await supabase.rpc("admin_approve_category", {
      p_admin_phone: adminRpcLabel(),
      p_category_id: cat.id,
    });
    setPendingAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    await notifyCategoryVendor(cat, "approved");
    logAdminAction("approve_category", "category", cat.id, null, adminAuditLabel());
    await loadPendingCategories();
  };

  const approvePendingLicense = async (row: (typeof pendingLicenses)[number]) => {
    setPendingLicenseAction(row.id);
    const { error } = await supabase.rpc("admin_approve_category_license", {
      p_admin_phone: adminRpcLabel(),
      p_category_id: row.id,
    });
    setPendingLicenseAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "approve_category_license",
      "category",
      row.id,
      row.license_type,
      adminAuditLabel(),
    );
    toast.success(`Approved license for ${row.label}`);
    await loadPendingLicenses();
    await loadPendingCategories();
  };

  const rejectPendingLicense = async (row: (typeof pendingLicenses)[number]) => {
    setPendingLicenseAction(row.id);
    const { error } = await supabase.rpc("admin_reject_category_license", {
      p_admin_phone: adminRpcLabel(),
      p_category_id: row.id,
    });
    setPendingLicenseAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "reject_category_license",
      "category",
      row.id,
      row.license_type,
      adminAuditLabel(),
    );
    await loadPendingLicenses();
    await loadPendingCategories();
  };

  const runLicenseBackfill = async () => {
    if (licenseBackfillRunning) return;
    setLicenseBackfillRunning(true);
    try {
      let remaining = 1;
      let classified = 0;
      let loops = 0;
      while (remaining > 0 && loops < 40) {
        loops += 1;
        const { data, error } = await supabase.functions.invoke("suggest-category", {
          body: { backfill_licenses: true, device_id: getDeviceId() },
        });
        if (error || !data?.success) {
          toast.error(error?.message || data?.error || "License classification failed");
          break;
        }
        const batch = Array.isArray(data.results) ? data.results.length : 0;
        classified += batch;
        remaining = Number(data.remaining ?? 0);
        if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;
      }
      toast.success(
        classified > 0
          ? `Classified ${classified} categories — pending your review`
          : "No unclassified categories left",
      );
      await loadPendingLicenses();
    } finally {
      setLicenseBackfillRunning(false);
    }
  };

  const openMergeCategoryDialog = async (cat: (typeof pendingCategories)[number]) => {
    setPendingAction(cat.id);
    try {
      const { data, error } = await supabase
        .from("categories")
        .select("id, label, emoji")
        .eq("is_active", true)
        .or("status.eq.active,status.is.null")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const opts = (data ?? []).filter((c) => c.id !== cat.id);
      setMergeTargetOptions(opts);
      const overlapMatch = cat.overlap_category_label
        ? opts.find(
            (c) =>
              c.label.trim().toLowerCase() ===
              cat.overlap_category_label!.trim().toLowerCase(),
          )
        : null;
      setMergeCategoryDialog({
        open: true,
        cat,
        targetId: overlapMatch?.id ?? opts[0]?.id ?? "",
      });
    } catch (err) {
      console.error("openMergeCategoryDialog", err);
      toast.error("Could not load categories for merge");
    } finally {
      setPendingAction(null);
    }
  };

  const mergePendingCategoryAsAlias = async () => {
    const cat = mergeCategoryDialog.cat;
    const targetId = mergeCategoryDialog.targetId;
    if (!cat || !targetId) return;
    setPendingAction(cat.id);
    const { error } = await supabase.rpc("admin_merge_category_as_alias", {
      p_admin_phone: adminRpcLabel(),
      p_pending_category_id: cat.id,
      p_target_category_id: targetId,
    });
    setPendingAction(null);
    setMergeCategoryDialog({ open: false, cat: null, targetId: "" });
    if (error) {
      toast.error("Merge failed: " + error.message);
      return;
    }
    const targetLabel =
      mergeTargetOptions.find((c) => c.id === targetId)?.label ?? targetId;
    logAdminAction(
      "merge_category_as_alias",
      "category",
      cat.id,
      `merged into ${targetLabel}`,
      adminAuditLabel(),
    );
    toast.success(`Merged “${cat.label}” into ${targetLabel}`);
    await loadPendingCategories();
  };

  const rejectPendingCategory = async (cat: (typeof pendingCategories)[number]) => {
    setPendingAction(cat.id);
    const { error: updateError } = await supabase.rpc("admin_reject_category", {
      p_admin_phone: adminRpcLabel(),
      p_category_id: cat.id,
    });
    setPendingAction(null);
    if (updateError) {
      toast.error("Update failed: " + updateError.message);
      return;
    }
    await notifyCategoryVendor(cat, "rejected");
    logAdminAction("reject_category", "category", cat.id, null, adminAuditLabel());
    await loadPendingCategories();
  };

  const approvePendingAlias = async (row: (typeof pendingAliases)[number]) => {
    setPendingAliasAction(row.id);
    const { error } = await supabase.rpc("admin_approve_search_term", {
      p_admin_phone: adminRpcLabel(),
      p_term_id: row.id,
    });
    setPendingAliasAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "approve_search_alias",
      "search_alias",
      row.id,
      `${row.term} → ${row.category_label}`,
      adminAuditLabel(),
    );
    toast.success(`Approved “${row.term}” for ${row.category_label}`);
    await loadPendingAliases();
    void import("@/lib/categorySearchTerms").then((m) => m.refreshCategorySearchTermsCache());
  };

  const rejectPendingAlias = async (row: (typeof pendingAliases)[number]) => {
    setPendingAliasAction(row.id);
    const { error } = await supabase.rpc("admin_reject_search_term", {
      p_admin_phone: adminRpcLabel(),
      p_term_id: row.id,
    });
    setPendingAliasAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction("reject_search_alias", "search_alias", row.id, row.term, adminAuditLabel());
    await loadPendingAliases();
  };

  const approvePendingVendorBusiness = async (
    row: (typeof pendingVendorBusinesses)[number],
  ) => {
    setPendingBusinessAction(row.vendor_category_id);
    const { error } = await supabase.rpc("admin_approve_vendor_business", {
      p_admin_phone: adminRpcLabel(),
      p_vendor_category_id: row.vendor_category_id,
    });
    setPendingBusinessAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "approve_vendor_business",
      "vendor_category",
      row.vendor_category_id,
      `${row.shop_name ?? row.vendor_phone} → ${row.category_label}`,
      adminAuditLabel(),
    );
    toast.success(`Approved ${row.category_label} for ${row.shop_name ?? row.vendor_phone}`);
    await loadPendingVendorBusinesses();
  };

  const rejectPendingVendorBusiness = async (
    row: (typeof pendingVendorBusinesses)[number],
    reason: string,
  ) => {
    setPendingBusinessAction(row.vendor_category_id);
    const { error } = await supabase.rpc("admin_reject_vendor_business", {
      p_admin_phone: adminRpcLabel(),
      p_vendor_category_id: row.vendor_category_id,
      p_reason: reason.trim() || null,
    });
    setPendingBusinessAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "reject_vendor_business",
      "vendor_category",
      row.vendor_category_id,
      reason.trim() || null,
      adminAuditLabel(),
    );
    toast.success(`Rejected ${row.category_label} for ${row.shop_name ?? row.vendor_phone}`);
    await loadPendingVendorBusinesses();
  };

  const loadModeConfidenceVendorSide = async (
    reviewId: string,
    categoryId: string,
    mode: string,
  ) => {
    const key = `${reviewId}:${mode}`;
    if (modeConfidenceVendors[key]) {
      setModeConfidenceExpanded((cur) => (cur === key ? null : key));
      return;
    }
    setModeConfidenceVendorsLoading(key);
    const { data, error } = await supabase.rpc("admin_list_category_mode_vendors", {
      p_admin_phone: adminRpcLabel(),
      p_category_id: categoryId,
      p_mode: mode,
    });
    setModeConfidenceVendorsLoading(null);
    if (error) {
      toast.error("Could not load vendors: " + error.message);
      return;
    }
    const list = (Array.isArray(data) ? data : []).map(
      (v: { shop_name?: string | null; phone?: string | null }) => ({
        shop_name: v.shop_name ?? null,
        phone: v.phone ?? null,
      }),
    );
    setModeConfidenceVendors((prev) => ({ ...prev, [key]: list }));
    setModeConfidenceExpanded(key);
  };

  const confirmModeConfidenceReview = async (row: (typeof modeConfidenceReviews)[number]) => {
    setModeConfidenceAction(row.id);
    const { error } = await supabase.rpc("admin_confirm_category_mode_review", {
      p_admin_phone: adminRpcLabel(),
      p_review_id: row.id,
    });
    setModeConfidenceAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "confirm_mode_confidence",
      "category_mode_review",
      row.id,
      `${row.category_label}: ${row.current_default_mode} → ${row.proposed_mode}`,
      adminAuditLabel(),
    );
    toast.success(
      `Updated ${row.category_label} default to ${getServiceModeLabel(row.proposed_mode)}`,
    );
    await loadModeConfidenceReviews();
  };

  const dismissModeConfidenceReview = async (row: (typeof modeConfidenceReviews)[number]) => {
    setModeConfidenceAction(row.id);
    const { error } = await supabase.rpc("admin_dismiss_category_mode_review", {
      p_admin_phone: adminRpcLabel(),
      p_review_id: row.id,
    });
    setModeConfidenceAction(null);
    if (error) {
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction(
      "dismiss_mode_confidence",
      "category_mode_review",
      row.id,
      row.category_label,
      adminAuditLabel(),
    );
    toast.success(`Dismissed mode review for ${row.category_label}`);
    await loadModeConfidenceReviews();
  };

  const openVendorInAdminList = (phone: string | null | undefined) => {
    const q = (phone ?? "").trim();
    if (!q) return;
    setVendorListFilter("all");
    setVendorSearch(q);
    setVendorModerationOpen(true);
  };

  const confidenceBadgeClass = (confidence: string | null, score: number | null) => {
    if (score != null && Number.isFinite(score)) {
      if (score >= 0.85) {
        return "bg-green-500/10 text-green-700 border border-green-500/30";
      }
      if (score >= 0.5) {
        return "bg-amber-500/10 text-amber-700 border border-amber-500/30";
      }
      return "bg-destructive/10 text-destructive border border-destructive/30";
    }
    if (confidence === "high") {
      return "bg-green-500/10 text-green-700 border border-green-500/30";
    }
    if (confidence === "medium") {
      return "bg-amber-500/10 text-amber-700 border border-amber-500/30";
    }
    if (confidence === "low") {
      return "bg-destructive/10 text-destructive border border-destructive/30";
    }
    return "bg-muted text-muted-foreground border border-border";
  };

  const beginVerifyOrUnverify = (
    vendor: (typeof vendorList)[number],
    mode: "verify" | "unverify",
  ) => {
    const cats = vendor.categories.filter((c) => c.category_id);
    if (cats.length === 0) {
      toast.error(s.admin_no_business_to_verify);
      return;
    }
    if (cats.length <= 1) {
      const cat = cats[0];
      if (mode === "verify") openVerifySheet(vendor, cat);
      else void confirmUnverifyCategory(vendor.id, cat.category_id);
      return;
    }
    const actionable =
      mode === "verify"
        ? cats.filter((c) => !c.is_manual_verified)
        : cats.filter((c) => c.is_manual_verified);
    if (actionable.length === 0) {
      toast(mode === "verify" ? "All businesses already verified" : "No verified businesses");
      return;
    }
    if (actionable.length === 1) {
      if (mode === "verify") openVerifySheet(vendor, actionable[0]);
      else void confirmUnverifyCategory(vendor.id, actionable[0].category_id);
      return;
    }
    setVerifyBusinessPicker({ open: true, vendor, mode });
  };

  const closeVerifySheetUi = () => {
    setVerifySheet({ open: false, vendor: null, category: null });
    setVerifyChecks({});
    setVerifyAutoTicked(new Set());
    setVerifyReferrerLabel(null);
  };

  const closeVerifySheet = () => {
    const shouldPop = verifyHistoryPushedRef.current;
    verifyHistoryPushedRef.current = false;
    closeVerifySheetUi();
    if (shouldPop && (window.history.state as { aaspaasVerifySheet?: boolean } | null)?.aaspaasVerifySheet) {
      window.history.back();
    }
  };

  // Verify sheet: hardware/browser back closes sheet instead of leaving Settings.
  useEffect(() => {
    const onPopState = () => {
      if (!verifySheet.open) return;
      verifyHistoryPushedRef.current = false;
      closeVerifySheetUi();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [verifySheet.open]);

  useEffect(() => {
    if (!verifySheet.open) {
      setOverlayBackHandler(null);
      return;
    }
    setOverlayBackHandler(() => {
      if (verifyHistoryPushedRef.current) {
        window.history.back();
        return true;
      }
      closeVerifySheetUi();
      return true;
    });
    return () => setOverlayBackHandler(null);
  }, [verifySheet.open]);

  const openVerifySheet = (
    vendor: (typeof vendorList)[number],
    category: AdminVendorCategory,
  ) => {
    const progressId = category.category_id
      ? `${vendor.id}:${category.category_id}`
      : vendor.id;
    const savedChecks = loadVerifyChecks(progressId);
    const autoChecks = buildVerifyAutoChecks({
      shop_photo_url: category.shop_photo_url ?? vendor.shop_photo_url,
      gps_match_distance: category.gps_match_distance ?? vendor.gps_match_distance,
      location_accuracy: category.location_accuracy,
      photo_accuracy: category.photo_accuracy,
      verification_status: category.verification_status,
      upi_verified: vendor.upi_verified,
    });
    setVerifyAutoTicked(
      new Set(Object.keys(autoChecks).filter((k) => autoChecks[k])),
    );
    setVerifySheet({ open: true, vendor, category });
    setVerifyChecks({ ...emptyVerifyChecks(), ...autoChecks, ...savedChecks });
    setVerifyReferrerLabel(null);
    if (!verifyHistoryPushedRef.current) {
      window.history.pushState({ aaspaasVerifySheet: true }, "");
      verifyHistoryPushedRef.current = true;
    }
    void (async () => {
      const { data: ref } = await supabase
        .from("referrals")
        .select("referrer_vendor_id")
        .eq("referee_id", vendor.id)
        .eq("referee_type", "vendor")
        .limit(1)
        .maybeSingle();
      if (!ref?.referrer_vendor_id) {
        setVerifyReferrerLabel(s.referral_direct_signup);
        return;
      }
      const { data: referrer } = await supabase
        .from("vendors")
        .select("shop_name, phone")
        .eq("id", ref.referrer_vendor_id)
        .maybeSingle();
      if (referrer?.shop_name) {
        setVerifyReferrerLabel(`${referrer.shop_name} · ${referrer.phone ?? ""}`.trim());
      } else {
        setVerifyReferrerLabel(s.referral_direct_signup);
      }
    })();
  };

  const totalCheckedCount = VERIFY_ITEM_IDS.filter((id) => verifyChecks[id] === true).length;
  const allChecked = VERIFY_ITEM_IDS.every((id) => verifyChecks[id] === true);

  const notifyVendorVerification = (
    vendorId: string,
    phone: string | null | undefined,
    payload: {
      type: string;
      title: string;
      body: string;
    },
  ) => {
    void invokeNotifyVendor({
      vendor_id: vendorId,
      notification_title: payload.title,
      message: payload.body,
      type: payload.type,
    });
  };

  const confirmVerify = async () => {
    if (!verifySheet.vendor || !allChecked) return;
    const vendor = verifySheet.vendor;
    const category = verifySheet.category;
    const categoryId = category?.category_id;
    if (!categoryId) {
      toast.error("Select a business category to verify");
      return;
    }
    const verifyingKey = `${vendor.id}:${categoryId}`;
    if (adminVerifyLockRef.current.has(verifyingKey)) return;
    adminVerifyLockRef.current.add(verifyingKey);
    setVerifying(verifyingKey);

    try {
      const { error } = await supabase.rpc("admin_verify_vendor_category", {
        p_admin_phone: adminRpcLabel(),
        p_vendor_id: vendor.id,
        p_category_id: categoryId,
      });
      if (error) {
        toast.error("Update failed: " + error.message);
        return;
      }
      notifyVendorVerification(vendor.id, vendor.phone, {
        type: "account_verified",
        title: s.vendor_approved_title,
        body: s.vendor_approved_body,
      });
      logAdminAction("verify_vendor_category", "vendor_category", categoryId, null, adminAuditLabel());
      logAdminAction("admin_check_passed", "vendor", vendor.id, "admin_check", adminAuditLabel());
      localStorage.removeItem(verifyProgressKey(verifyingKey));
      await loadVendorList();
      closeVerifySheet();
      toast(s.settings_vendorVerified);
    } finally {
      adminVerifyLockRef.current.delete(verifyingKey);
      setVerifying((current) => (current === verifyingKey ? null : current));
    }
  };

  const confirmUnverifyCategory = async (
    vendorId: string,
    categoryId: string | null,
  ) => {
    if (!categoryId) {
      toast.error("Missing business category");
      return;
    }
    if (!window.confirm(s.settings_removeVerifyConfirm)) return;
    const verifyingKey = `${vendorId}:${categoryId}`;
    setVerifying(verifyingKey);
    const { error } = await supabase.rpc("admin_unverify_vendor_category", {
      p_admin_phone: adminRpcLabel(),
      p_vendor_id: vendorId,
      p_category_id: categoryId,
    });
    if (error) {
      setVerifying(null);
      toast.error("Update failed: " + error.message);
      return;
    }
    logAdminAction("unverify_vendor_category", "vendor_category", categoryId, null, adminAuditLabel());
    logAdminAction("admin_check_failed", "vendor", vendorId, "admin_check", adminAuditLabel());
    await loadVendorList();
    setVerifying(null);
    toast(s.settings_verificationRemoved);
  };

  const confirmUnverify = async (vendorId: string) => {
    const vendor = vendorList.find((v) => v.id === vendorId);
    if (!vendor) return;
    beginVerifyOrUnverify(vendor, "unverify");
  };

  const filteredVendors = useMemo(() => {
    return [...vendorList].sort((a, b) => {
      if (a.is_manual_verified !== b.is_manual_verified) {
        return a.is_manual_verified ? 1 : -1;
      }
      const trustDiff = trustLevelRank(b.trustLevel) - trustLevelRank(a.trustLevel);
      if (trustDiff !== 0) return trustDiff;
      return (a.shop_name ?? "").localeCompare(b.shop_name ?? "");
    });
  }, [vendorList]);

  useEffect(() => {
    if (!highlightVendorId || !isAdmin) return;
    if (vendorList.some((v) => v.id === highlightVendorId)) return;
    void (async () => {
      const { data, error } = await supabase
        .from("vendors")
        .select(VENDOR_LIST_SELECT)
        .eq("id", highlightVendorId)
        .maybeSingle();
      if (error || !data) return;
      const merged = await enrichVendorsWithMeta([data]);
      if (merged.length === 0) return;
      setVendorList((prev) =>
        prev.some((v) => v.id === highlightVendorId) ? prev : [...merged, ...prev],
      );
    })();
  }, [highlightVendorId, isAdmin, vendorList]);

  useEffect(() => {
    if (!highlightVendorId || !isAdmin) return;
    setVendorModerationOpen(true);
    const el = document.getElementById(`admin-vendor-${highlightVendorId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashVendorId(highlightVendorId);
    const t = window.setTimeout(() => setFlashVendorId(null), 2000);
    return () => window.clearTimeout(t);
  }, [highlightVendorId, isAdmin, vendorList.length]);

  // Hidden gesture: tap the page title 7× to reveal the Admin tab (login still required).
  const tapTitle = () => {
    const next = titleTaps + 1;
    setTitleTaps(next);
    if (next >= 7) {
      setTitleTaps(0);
      setAdminTabRevealed(true);
    }
  };

  const reset = async () => {
    await stopAllVendorLocationTracking();
    const phone = localStorage.getItem("aaspaas:user_phone");
    const deviceId = getDeviceId();
    if (phone) {
      const { error } = await supabase.rpc("clear_my_data", {
        p_user_phone: phone,
        p_device_id: deviceId,
      });
      if (error) {
        captureError(error, { scope: "settings.clearMyData", phone });
        toast.error(s.settings_clearDataFailed);
        return;
      }
    }

    Object.keys(localStorage)
      .filter((key) => key.startsWith("aaspaas:"))
      .forEach((key) => localStorage.removeItem(key));

    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const key = sessionStorage.key(i);
      if (key?.startsWith("aaspaas:")) sessionStorage.removeItem(key);
    }

    let notificationNudge: string | undefined;
    try {
      const live = await checkNativePermissionStatuses();
      if (isPermissionGranted(live.notifications)) {
        notificationNudge = s.settings_clearDataDescription_permissions;
      }
    } catch {
      /* OS check failed — skip the post-clear nudge */
    }

    showClearMyDataSuccessThenReload({
      message: phone ? s.settings_accountDataCleared : s.settings_localDataCleared,
      description: notificationNudge,
      toastSuccess: (message, description) =>
        description
          ? toast.success(message, { description })
          : toast.success(message),
    });
  };

  const startEditAddress = (addr: (typeof addresses)[number]) => {
    setEditingAddressId(addr.id);
    setEditAddressValue(addr.address_text);
  };

  const cancelEditAddress = () => {
    setEditingAddressId(null);
    setEditAddressValue("");
  };

  const saveEditAddress = async () => {
    const trimmed = editAddressValue.trim();
    if (!trimmed || !editingAddressId) {
      toast.error(s.settings_addressEmptyError);
      return;
    }
    setSavingAddress(true);
    const phone = userPhone?.trim();
    if (!phone) {
      setSavingAddress(false);
      toast.error(s.settings_addressPhoneRequiredSave);
      return;
    }
    const { error } = await supabase.rpc("update_user_address", {
      p_user_phone: phone,
      p_address_id: editingAddressId,
      p_address_text: trimmed,
    });
    setSavingAddress(false);
    if (error) {
      captureError(error, { scope: "settings.saveEditAddress" });
      toast.error(error.message);
      return;
    }
    cancelEditAddress();
    await refreshAddresses();
  };

  const confirmDeleteAddress = async () => {
    if (!deleteAddressId) return;
    setDeletingAddress(true);
    const phone = userPhone?.trim();
    if (!phone) {
      setDeletingAddress(false);
      toast.error(s.settings_addressPhoneRequiredDelete);
      return;
    }
    const { error } = await supabase.rpc("delete_user_address", {
      p_user_phone: phone,
      p_address_id: deleteAddressId,
    });
    setDeletingAddress(false);
    if (error) {
      captureError(error, { scope: "settings.confirmDeleteAddress" });
      toast.error(error.message);
      return;
    }
    setDeleteAddressId(null);
    if (editingAddressId === deleteAddressId) {
      cancelEditAddress();
    }
    await refreshAddresses();
  };

  const openDeleteAccountConfirm = async () => {
    const phone = userPhone?.trim();
    if (!phone) {
      setDualRoleDelete(false);
      setDeleteConfirmOpen(true);
      return;
    }

    // OTP-off: both vendors (hidden/draft rows) and users are unreadable
    // directly under RLS; use the phone-identity RPCs instead.
    const [{ data: vendorRows }, { data: userRows }] = await Promise.all([
      supabase.rpc("get_vendor_deletion_status", { p_phone: phone }),
      supabase.rpc("lookup_user_by_phone", { p_phone: phone }),
    ]);

    const vendorExists = Array.isArray(vendorRows) && vendorRows.length > 0;
    const userExists = Array.isArray(userRows) && userRows.length > 0;
    setDualRoleDelete(vendorExists && userExists);
    setDeleteConfirmOpen(true);
  };

  const confirmDeleteAccount = async () => {
    const phone = userPhone?.trim();
    if (!phone) return;

    setDeleteAccountLoading(true);
    // Catch phones saved before ensure_user_device_link existed (web / no-push).
    await ensureUserDeviceLink(phone);
    const result = await invokeDeleteAccount(
      phone,
      isVendor ? "vendor" : "customer",
      deviceId,
    );
    setDeleteAccountLoading(false);
    setDeleteConfirmOpen(false);

    if (result.ok === false) {
      captureError(new Error(result.error), { scope: "settings.invokeDeleteAccount" });
      toast.error(result.error);
      return;
    }

    if (isVendor) {
      const { data } = await supabase.rpc("get_vendor_deletion_status", {
        p_phone: phone,
      });
      const row = Array.isArray(data) ? data[0] : null;
      setVendorDeletionRequestedAt(
        row?.deletion_requested_at ?? new Date().toISOString(),
      );
      toast.success(s.delete_account_success_vendor);
      return;
    }

    toast.success(
      result.message ??
        (dualRoleDelete && !isVendor
          ? s.delete_account_success_dual_role
          : s.delete_account_success_customer),
    );
    try {
      localStorage.removeItem("aaspaas:user_phone");
      localStorage.removeItem("aaspaas:device_id");
    } catch {
      /* ignore */
    }
    window.setTimeout(() => window.location.reload(), 1500);
  };

  const cancelAccountDeletion = async () => {
    const phone = userPhone?.trim();
    if (!phone) return;

    setDeleteAccountLoading(true);
    const result = await invokeCancelDeletion(phone, deviceId);
    setDeleteAccountLoading(false);

    if (result.ok === false) {
      captureError(new Error(result.error), { scope: "settings.invokeCancelDeletion" });
      toast.error(result.error);
      return;
    }

    setVendorDeletionRequestedAt(null);

    let restoredId = vendorId?.trim() || "";
    let restoredActive = vendor?.is_active === true;
    if (!restoredId) {
      const { data } = await supabase.rpc("get_vendor_restore_status", {
        p_phone: phone,
      });
      const status = data as {
        vendor_id?: string | null;
        restore_allowed?: boolean;
        is_active?: boolean;
      } | null;
      if (status?.restore_allowed && status.vendor_id) {
        restoredId = status.vendor_id;
        restoredActive = status.is_active === true;
      }
    }
    if (restoredId) {
      restoreVendorSession(restoredId, restoredActive);
      notifyVendorIdChanged();
    }

    toast.success(s.delete_account_cancelled);
  };

  const submitAdminLogin = async (event: FormEvent) => {
    event.preventDefault();
    setAdminLoginError(null);
    setAdminLoginSubmitting(true);

    const email = adminLoginEmail.trim();
    const password = adminLoginPassword;

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setAdminLoginSubmitting(false);
      setAdminLoginError("Invalid email or password");
      return;
    }

    const isAdminSession = await checkAdminSession();
    setAdminLoginSubmitting(false);

    if (!isAdminSession) {
      await supabase.auth.signOut();
      setAdminLoginError("Invalid email or password");
      return;
    }

    setAdminLoginPassword("");
    setActiveTab("admin");
  };

  const logOutAdmin = async () => {
    setAdminTabRevealed(false);
    setIsAdmin(false);
    setAdminSessionEmail(null);
    setActiveTab("settings");
    setAdminLoginEmail("");
    setAdminLoginPassword("");
    setAdminLoginError(null);
    await supabase.auth.signOut();
  };

  return (
    <AppShell theme="dark">
      <div
        className="pb-8"
        data-testid="settings-screen"
        data-admin-auth-checked={adminAuthChecked ? "true" : "false"}
      >
      {adminTabRevealed && (
      <div className="flex gap-2 px-4 pt-2 pb-4" data-testid="settings-admin-tabs">
          <button
            type="button"
            data-testid="settings-tab-settings"
            onClick={() => setActiveTab("settings")}
            className={cn(
              "flex-1 rounded-xl border py-2.5 text-sm font-bold transition-colors active:scale-[0.98]",
              activeTab === "settings"
                ? "border-brand bg-brand/15 text-brand"
                : "border-surface-border bg-surface text-muted-foreground",
            )}
          >
            Settings
          </button>
          <button
            type="button"
            data-testid="settings-tab-admin"
            onClick={() => setActiveTab("admin")}
            className={cn(
              "flex-1 rounded-xl border py-2.5 text-sm font-bold transition-colors active:scale-[0.98]",
              activeTab === "admin"
                ? "border-brand bg-brand/15 text-brand"
                : "border-surface-border bg-surface text-muted-foreground",
            )}
          >
            Admin
          </button>
        </div>
      )}

      {(!adminTabRevealed || activeTab === "settings") && (
      <>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <SettingsPageHeader
            title={s.settings_tagline}
            subtitle={s.settings_heading}
            onTitleClick={tapTitle}
          />
        </div>
        <NotificationBell className="mt-6 mr-4 shrink-0" />
      </div>

      {!vendorId && (
        <SettingsCard>
          <button
            type="button"
            onClick={() => navigate("/vendor")}
            className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:opacity-90"
          >
            <span className="h-10 w-10 shrink-0 rounded-xl bg-brand/10 border border-brand/30 grid place-items-center">
              <Store className="h-5 w-5 text-brand" />
            </span>
            <span className="text-sm font-medium text-foreground">{s.settings_register_business}</span>
          </button>
          <p className="text-xs text-muted-foreground px-4 pb-3">{s.settings_register_business_sub}</p>
        </SettingsCard>
      )}

      <SettingsParentCollapsible
        label={s.settings_myAccount}
        open={accountOpen}
        onToggle={() => setAccountOpen((o) => !o)}
        testId="settings-my-account-toggle"
      >
        <SettingsCollapsible
          label={s.settings_myIdentity}
          open={identityOpen}
          onToggle={() => setIdentityOpen((o) => !o)}
          nested
          testId="settings-identity-toggle"
        >
          <div className="px-4 py-3.5">
            {!vendorId ? (
              (userPhone ?? "").trim() ? (
                <div>
                  <p className="text-sm font-medium text-foreground" data-testid="settings-identity-phone">
                    {s.settings_phonePrefix}
                    {(userPhone ?? "").trim()}
                  </p>
                  <p className="text-xs text-brand mt-1">{s.settings_registered}</p>
                  <button
                    type="button"
                    data-testid="settings-change-phone"
                    onClick={() => setPhoneEntryOpen(true)}
                    className="mt-3 text-sm font-semibold text-brand active:opacity-80"
                  >
                    {s.settings_changePhone}
                  </button>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-medium text-foreground">{s.settings_noPhone}</p>
                  <p className="text-xs text-muted-foreground mt-1">{s.settings_noPhoneHint}</p>
                  <button
                    type="button"
                    data-testid="settings-add-phone"
                    onClick={() => setPhoneEntryOpen(true)}
                    className="mt-3 w-full rounded-xl border border-brand/40 bg-brand/10 py-2.5 text-sm font-semibold text-brand active:opacity-90"
                  >
                    {s.settings_addPhone}
                  </button>
                </div>
              )
            ) : identityPhone != null ? (
              <div>
                <p className="text-sm font-medium text-foreground">
                  {s.settings_phonePrefix}
                  {identityPhone}
                </p>
                <p className="text-xs text-brand mt-1">{s.settings_registered}</p>
              </div>
            ) : (
              <div>
                <p className="text-sm font-medium text-foreground">{s.settings_noPhone}</p>
                <p className="text-xs text-muted-foreground mt-1">{s.settings_noPhoneHint}</p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground/70 mt-3 tabular-nums">
              {s.settings_devicePrefix}
              {deviceId.slice(0, 8)}
              {s.settings_deviceEllipsis}
            </p>
          </div>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={s.settings_accountStanding}
          open={accountStandingOpen}
          onToggle={() => setAccountStandingOpen((o) => !o)}
          nested
          testId="settings-account-standing-toggle"
        >
          <div className="px-4 py-3.5" data-testid="account-standing-row">
            <span
              className={cn(
                "inline-block rounded-full border px-3 py-1.5 text-xs font-semibold leading-snug",
                accountStanding.tone === "banned" &&
                  "bg-destructive/10 text-destructive border-destructive/30",
                accountStanding.tone === "complaints" &&
                  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
                accountStanding.tone === "fair" &&
                  "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
                accountStanding.tone === "good" &&
                  "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30",
                accountStanding.tone === "unavailable" &&
                  "bg-muted text-muted-foreground border-surface-border",
              )}
            >
              {accountStanding.label}
            </span>
          </div>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={
            addressesFailed
              ? s.settings_myDeliveryAddresses
              : `${s.settings_myDeliveryAddresses} (${addresses.length})`
          }
          open={addressesOpen}
          onToggle={() => setAddressesOpen((o) => !o)}
          nested
        >
        {addressesLoading ? (
          <p className="text-sm text-muted-foreground px-4 py-3.5">{s.settings_loading}</p>
        ) : addressesFailed ? (
          <div className="px-4 py-3.5 space-y-2">
            <p className="text-sm text-destructive">{s.settings_addressesUnavailable}</p>
            <button
              type="button"
              onClick={() => void refreshAddresses()}
              className="rounded-xl border border-surface-border px-3 py-1.5 text-xs font-semibold text-foreground"
            >
              {s.network_retry_btn}
            </button>
          </div>
        ) : addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground px-4 py-3.5">{s.settings_noAddresses}</p>
        ) : (
          <ul>
            {addresses.map((addr, idx) => (
              <li
                key={addr.id}
                className={cn(
                  "px-4 py-3.5",
                  idx < addresses.length - 1 && "border-b border-surface-border",
                )}
              >
                {editingAddressId === addr.id ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editAddressValue}
                      onChange={(e) => setEditAddressValue(e.target.value)}
                      className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:border-brand"
                      autoFocus
                    />
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEditAddress()}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-brand disabled:opacity-50"
                        aria-label={s.settings_save}
                      >
                        {s.settings_save}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditAddress}
                        disabled={savingAddress}
                        className="text-xs font-semibold text-muted-foreground disabled:opacity-50"
                        aria-label={s.settings_cancel}
                      >
                        ❌ {s.settings_cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <p className="flex-1 min-w-0 text-sm text-foreground truncate">
                      {addr.address_text}
                    </p>
                    <button
                      type="button"
                      onClick={() => startEditAddress(addr)}
                      className="shrink-0 h-8 w-8 rounded-lg border border-surface-border text-sm active:opacity-80"
                      aria-label="Edit address"
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteAddressId(addr.id)}
                      className="shrink-0 h-8 w-8 rounded-lg border border-surface-border text-sm active:opacity-80"
                      aria-label="Delete address"
                    >
                      🗑️
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        </SettingsCollapsible>


        <SettingsCollapsible
          label={s.settings_preferences}
          open={preferencesOpen}
          onToggle={() => setPreferencesOpen((o) => !o)}
          nested
        >
        <SettingsRow
          label={s.theme}
          sublabel={theme === "dark" ? s.dark : s.light}
        >
          <button
            type="button"
            data-testid="theme-toggle"
            onClick={toggleTheme}
            className="h-10 w-10 shrink-0 grid place-items-center rounded-xl border border-surface-border bg-surface text-brand active:opacity-90"
            aria-label={s.theme}
          >
            {theme === "dark" ? (
              <Moon className="h-5 w-5" aria-hidden />
            ) : (
              <Sun className="h-5 w-5" aria-hidden />
            )}
          </button>
        </SettingsRow>
        <div className="px-4 pb-3.5 border-t border-surface-border pt-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            {s.settings_language}
          </p>
          <Select value={lang} onValueChange={(value) => setLang(value as Language)}>
            <SelectTrigger
              data-testid="language-select"
              className="w-full rounded-xl border-surface-border bg-surface h-auto px-3 py-2.5 font-medium text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {languageOptions.map(([code, label]) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="px-4 py-3.5 border-t border-surface-border">
          <p className="text-sm font-medium text-foreground">{s.settings_voiceInputLang}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Language used when speaking to the app
          </p>
        </div>
        <div className="px-4 pb-2 flex gap-2">
          {VOICE_INPUT_OPTIONS.map(({ code, labelKey }) => (
            <button
              key={code}
              type="button"
              onClick={() => {
                localStorage.setItem(VOICE_LANG_KEY, code);
                setVoiceInputLang(code);
              }}
              className={cn(
                "flex-1 rounded-xl border py-2.5 text-sm font-bold transition-colors active:scale-[0.98]",
                voiceInputLang === code
                  ? "border-brand bg-brand/15 text-brand"
                  : "border-surface-border bg-surface text-muted-foreground",
              )}
            >
              {s[labelKey]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground px-4 pb-3.5 border-b border-surface-border">
          {s.settings_voiceAutoDetect}
        </p>
        <SettingsRow label={s.settings_largeText} sublabel={s.settings_largeTextHint}>
          <Switch
            className="data-[state=checked]:bg-brand"
            checked={largeText}
            onCheckedChange={(checked) => {
              setLargeText(checked);
              try {
                localStorage.setItem(LARGE_TEXT_KEY, checked ? "true" : "false");
              } catch {
                /* ignore */
              }
              document.documentElement.classList.toggle("large-text", checked);
            }}
          />
        </SettingsRow>
        </SettingsCollapsible>

        <SettingsCollapsible
          label={s.nav_feed}
          open={feedDiscoveryOpen}
          onToggle={() => setFeedDiscoveryOpen((o) => !o)}
          nested
          testId="settings-feed-discovery-toggle"
        >
          <div data-testid="settings-feed-discovery">
            {/* Account-level only (app_users.feed_discovery_radius_km) — never per-category. */}
            <SettingsRow
              label={s.settings_feedDiscoveryRadius}
              sublabel={s.settings_feedDiscoveryRadiusHint}
            />
            <div className="px-4 pb-3.5">
              <FeedReachChips
                mode="reader"
                value={feedDiscoveryRadiusKm}
                onChange={(km) => void onFeedDiscoveryRadiusChange(km)}
                disabled={!userPhone}
              />
            </div>
            {/*
              Native: FCM via Capacitor. Web: same Settings toggle is the user
              gesture for Notification.requestPermission + web FCM token.
            */}
            <SettingsRow
              label={s.settings_feedNotifications}
              sublabel={
                Capacitor.isNativePlatform()
                  ? s.settings_feedNotificationsHint
                  : s.settings_browserNotificationsHint
              }
            >
              <Switch
                data-testid="settings-feed-notifications-switch"
                className="data-[state=checked]:bg-brand"
                checked={feedNotificationsEnabled}
                onCheckedChange={onFeedNotificationsChange}
              />
            </SettingsRow>
          </div>
        </SettingsCollapsible>
      </SettingsParentCollapsible>

      {vendorId && (
        <>
          {vendorLoadFailed && (
            <div className="px-4 mb-5 space-y-2" data-testid="settings-vendor-load-failed">
              <p className="text-sm text-destructive">{s.settings_vendorLoadFailed}</p>
              <button
                type="button"
                onClick={() => void loadVendorOwn()}
                className="rounded-xl border border-surface-border px-3 py-1.5 text-xs font-semibold text-foreground"
              >
                {s.network_retry_btn}
              </button>
            </div>
          )}
          {!vendorLoadFailed && (!vendor || !vendorExtras) && (
            <p className="text-sm text-muted-foreground px-4 mb-5">{s.settings_loading}</p>
          )}
          {vendor && vendorExtras && vendor.is_banned && (
            <div
              data-testid="settings-vendor-banned"
              className="min-h-[40vh] flex flex-col items-center justify-center px-6 mb-6 animate-fade-up"
            >
              <div className="w-full max-w-md rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-8 text-center space-y-3">
                <p className="text-lg font-bold text-foreground">{s.admin_vendor_banned_title}</p>
                <p className="text-sm text-foreground leading-relaxed">{s.admin_vendor_banned_body}</p>
              </div>
            </div>
          )}
          {vendor && vendorExtras && !vendor.is_banned && (
            <Tabs
              value={vendorPanelTab}
              onValueChange={(v) => setVendorPanelTab(v as "business" | "preferences")}
              className="px-4 mb-4"
            >
              <TabsList className="w-full grid grid-cols-2 h-11 bg-muted/80">
                <TabsTrigger
                  value="business"
                  data-testid="settings-vendor-tab-business"
                  className="text-sm font-semibold"
                >
                  {s.settings_myBusiness}
                </TabsTrigger>
                <TabsTrigger
                  value="preferences"
                  data-testid="settings-vendor-tab-preferences"
                  className="text-sm font-semibold"
                >
                  {s.settings_preferences}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="business" className="mt-4">
                <VendorMyBusiness
                  vendor={vendor}
                  onVendorUpdated={setVendor}
                  userPhone={userPhone}
                />
              </TabsContent>
              <TabsContent value="preferences" className="mt-4">
                <VendorSettings
                  vendor={vendor}
                  onVendorUpdated={setVendor}
                  shopOpen={shopOpen}
                  onShopOpenChange={setShopOpen}
                  referEarnVisible={referEarnVisible}
                  userPhone={userPhone}
                  referralCredits={vendorExtras.referralCredits}
                  openReviewsInitially={openVendorReviews}
                />
              </TabsContent>
            </Tabs>
          )}
        </>
      )}

      {Capacitor.isNativePlatform() && (
        <>
          <SettingsParentCollapsible
            label={s.settings_device_section}
            open={deviceOpen}
            onToggle={() => setDeviceOpen((o) => !o)}
          >
            <p className="px-3 pt-1 pb-2 text-xs font-bold uppercase tracking-widest text-brand">
              {s.settings_permission_heading}
            </p>
            <SettingsCard className="mx-0 mb-3 border-surface-border">
              <SettingsRow
                label={s.settings_permission_notifications}
                sublabel={permissionSublabel(
                  permissionStatuses.notifications,
                  s.settings_permission_notifications_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.notifications, () =>
                  void handlePermissionRequest(
                    "notifications",
                    s.settings_permission_notifications,
                  ),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_location}
                sublabel={permissionSublabel(
                  permissionStatuses.location,
                  s.settings_permission_location_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.location, () =>
                  void handlePermissionRequest("location", s.settings_permission_location),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_background_location}
                sublabel={permissionSublabel(
                  permissionStatuses.backgroundLocation,
                  s.settings_permission_background_location_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.backgroundLocation, () =>
                  void handlePermissionRequest(
                    "backgroundLocation",
                    s.settings_permission_background_location,
                  ),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_camera}
                sublabel={permissionSublabel(
                  permissionStatuses.camera,
                  s.settings_permission_camera_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.camera, () =>
                  void handlePermissionRequest("camera", s.settings_permission_camera),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_mic}
                sublabel={permissionSublabel(
                  permissionStatuses.microphone,
                  s.settings_permission_mic_sub,
                )}
              >
                {renderPermissionAction(permissionStatuses.microphone, () =>
                  void handlePermissionRequest("microphone", s.settings_permission_mic),
                )}
              </SettingsRow>
              <SettingsRow
                label={s.settings_permission_battery}
                sublabel={s.settings_permission_battery_sub}
              >
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">{s.settings_permission_manual}</span>
                  <button
                    type="button"
                    onClick={() => setPermissionHint(s.settings_permission_battery)}
                    className="shrink-0 rounded-lg border border-surface-border px-3 py-1.5 text-xs font-semibold text-foreground"
                  >
                    {s.onboard_open_settings}
                  </button>
                </div>
              </SettingsRow>
            </SettingsCard>
          </SettingsParentCollapsible>

          <AlertDialog
            open={permissionHint != null}
            onOpenChange={(open) => {
              if (!open) setPermissionHint(null);
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>{s.onboard_open_settings}</AlertDialogTitle>
                <AlertDialogDescription>
                  {permissionHint ? s.settings_permission_open_settings_body(permissionHint) : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogAction
                  className="mt-0"
                  onClick={(e) => {
                    e.preventDefault();
                    setPermissionHint(null);
                    void App.openUrl({ url: "app-settings:" });
                  }}
                >
                  {s.settings_ok}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      <SettingsParentCollapsible
        label={s.settings_connection_privacy}
        open={connectionOpen}
        onToggle={() => setConnectionOpen((o) => !o)}
      >
        <SettingsRow label={s.settings_trustSecurity} sublabel={s.settings_tlsNote}>
          <CheckCircle2 className="h-5 w-5 text-brand shrink-0" aria-hidden />
        </SettingsRow>
        <button
          type="button"
          data-testid="settings-privacy-policy-link"
          onClick={() => navigate("/privacy", { state: { returnTo: "/settings" } })}
          className="w-full flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-border text-left active:opacity-90"
        >
          <span className="text-sm font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2">
            {s.privacy_policy_title}
          </span>
          <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
        </button>
        <div className="px-4 pb-3.5">
          <p className="text-xs text-brand font-medium">{s.settings_dbConnected}</p>
        </div>
      </SettingsParentCollapsible>

      <button
        type="button"
        data-testid="settings-help-support-link"
        onClick={() => navigate("/settings/help")}
        className="mx-4 mt-2 w-[calc(100%-2rem)] flex items-center justify-between gap-3 rounded-xl border border-surface-border bg-card px-4 py-3.5 text-left active:opacity-90"
      >
        <span className="text-sm font-medium text-foreground">{s.help_support_title}</span>
        <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
      </button>

      <div className="mt-8 pt-4 border-t border-surface-border/50">
      <button
        type="button"
        onClick={() => setClearDataOpen(true)}
        className="mx-4 w-[calc(100%-2rem)] rounded-xl border border-destructive/40 text-destructive bg-transparent py-2.5 text-sm font-medium flex items-center justify-center gap-2 active:opacity-90"
      >
        <Trash2 className="h-4 w-4" /> {s.settings_clearMyData}
      </button>

      {userPhone && (
        <section className="mx-4 mt-4 space-y-3">
          <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold px-1">
            {s.delete_account_title}
          </p>
          {deleteAccountLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
            </div>
          ) : vendorDeletionRequestedAt ? (
            <>
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100 leading-relaxed">
                {s.delete_account_scheduled.replace(
                  "{date}",
                  formatVendorDeletionDate(vendorDeletionRequestedAt),
                )}
              </div>
              <button
                type="button"
                onClick={() => void cancelAccountDeletion()}
                className="w-full rounded-xl border border-border py-2.5 text-sm font-semibold text-foreground active:opacity-90"
              >
                {s.delete_account_cancel}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void openDeleteAccountConfirm()}
              className="w-full rounded-xl bg-destructive text-destructive-foreground py-2.5 text-sm font-semibold active:opacity-90"
            >
              {s.delete_account_title}
            </button>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground text-center py-4 mt-2">
        {s.settings_appName} · {s.settings_version}
        <br />
        {s.settings_copyright}
      </p>
      </div>

      </>
      )}

      {adminTabRevealed && activeTab === "admin" && !adminAuthChecked && (
        <div className="px-4 py-8 flex justify-center" data-testid="admin-auth-loading">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {adminTabRevealed && activeTab === "admin" && adminAuthChecked && !isAdmin && (
        <SettingsCard className="mx-4 border-brand/20" data-testid="admin-login-gate">
          <div className="px-4 py-3 border-b border-surface-border">
            <p className="text-sm font-medium text-foreground">Admin sign in</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Sign in with your admin account to access moderation tools.
            </p>
          </div>
          <form className="px-4 py-4 space-y-3" onSubmit={(e) => void submitAdminLogin(e)}>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground" htmlFor="admin-login-email">
                Email
              </label>
              <input
                id="admin-login-email"
                type="email"
                autoComplete="username"
                value={adminLoginEmail}
                onChange={(e) => setAdminLoginEmail(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-muted-foreground" htmlFor="admin-login-password">
                Password
              </label>
              <input
                id="admin-login-password"
                type="password"
                autoComplete="current-password"
                value={adminLoginPassword}
                onChange={(e) => setAdminLoginPassword(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            {adminLoginError && (
              <p className="text-xs text-destructive" data-testid="admin-login-error">
                {adminLoginError}
              </p>
            )}
            <button
              type="submit"
              disabled={adminLoginSubmitting || !adminLoginEmail.trim() || !adminLoginPassword}
              className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-brand-foreground disabled:opacity-50"
            >
              {adminLoginSubmitting ? "Signing in…" : "Sign in"}
            </button>
          </form>
        </SettingsCard>
      )}

      {adminTabRevealed && isAdmin && activeTab === "admin" && (
        <div data-testid="admin-panel">
          <div className="px-4 pb-2 flex justify-end">
            <button
              type="button"
              data-testid="admin-log-out"
              onClick={() => void logOutAdmin()}
              className="text-xs font-semibold text-muted-foreground underline"
            >
              Log out
            </button>
          </div>
          <section
            className="rounded-3xl bg-card border-2 border-dashed border-destructive/40 p-5 mb-5 mx-4"
            data-testid="admin-dev-phone-override"
          >
            <div className="flex items-center gap-2 mb-3">
              <Wrench className="h-4 w-4 text-destructive" />
              <p className="text-xs uppercase tracking-wider text-destructive font-semibold">
                {s.settings_devMenu}
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-semibold text-muted-foreground" htmlFor="dev-phone-number">
                Set phone number (dev)
              </label>
              <div className="flex gap-2">
                <input
                  id="dev-phone-number"
                  data-testid="admin-dev-phone-input"
                  value={devPhone}
                  onChange={(e) => setDevPhone(e.target.value)}
                  className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  type="button"
                  data-testid="admin-dev-phone-save"
                  onClick={() => {
                    saveUserPhone(devPhone);
                    window.location.reload();
                  }}
                  className="rounded-xl bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground"
                >
                  Save
                </button>
              </div>
            </div>
          </section>
          <SettingsCard className="border-brand/20">
            <div className="px-4 py-3 border-b border-surface-border">
              <p className="text-sm font-medium text-foreground">{s.settings_adminHealth}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{s.settings_adminOnly}</p>
            </div>
            <div className="px-4 py-3">

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{s.settings_orders}</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalOrders}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_allTime}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_thisWeek}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.ordersToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_today}</p>
              </div>
            </div>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{s.settings_vendors}</p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_total}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.totalCustomers}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_stat_total_customers}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">{adminStats.activeVendorsToday}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_activeToday}</p>
              </div>
              <div className="rounded-2xl bg-green-500/10 p-3 text-center">
                <p className="text-xl font-bold text-green-500">{adminStats.newVendorsThisWeek}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_newThisWeek}</p>
              </div>
              <div className="rounded-2xl bg-destructive/10 p-3 text-center">
                <p className="text-xl font-bold text-destructive">{adminStats.unverifiedVendors}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.settings_unverified}</p>
              </div>
              <div
                className="rounded-2xl bg-amber-500/10 p-3 text-center"
                data-testid="admin-stat-green-pending"
              >
                <p className="text-xl font-bold text-amber-600">
                  {adminStats.greenPendingVendors}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {s.admin_stat_green_pending}
                </p>
              </div>
            </div>

            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2 mt-4">
              Insights
            </p>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-2xl bg-amber-500/10 p-3 text-center">
                <p className="text-xl font-bold text-amber-600">{adminStats.stuckOrders}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_stat_stuck_orders}</p>
              </div>
              <div className="rounded-2xl bg-secondary/10 p-3 text-center">
                <p className="text-xl font-bold text-secondary">
                  {adminStats.avgVendorRating > 0 ? adminStats.avgVendorRating : "—"}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_stat_avg_rating}</p>
              </div>
              <div className="rounded-2xl bg-destructive/10 p-3 text-center">
                <p className="text-xl font-bold text-destructive">{adminStats.riskyUsers}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_stat_risky_users}</p>
              </div>
              <div className="rounded-2xl bg-brand/10 p-3 text-center">
                <p className="text-xl font-bold text-brand">{adminStats.totalReferrals}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_stat_total_referrals}</p>
              </div>
            </div>
            </div>
          </SettingsCard>

          <AdminSystemHealthCard />

          <SettingsCollapsible
            label={s.admin_vendor_moderation}
            open={vendorModerationOpen}
            onToggle={() => setVendorModerationOpen((o) => !o)}
            badge={
              flaggedUsers.length > 0 ? (
                <span className="bg-destructive/20 text-destructive text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {flaggedUsers.length}
                </span>
              ) : undefined
            }
          >
            <div className="px-4 py-3 border-b border-surface-border">
              <p className="text-sm font-medium text-foreground">{s.settings_vendorVerification}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {vendorListFilter === "all"
                  ? s.admin_show_all_vendors
                  : vendorListFilter === "green_ready"
                    ? s.admin_show_green_ready
                    : s.admin_show_flagged_only}
              </p>
            </div>
            <div className="px-4 py-3">
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3 py-2 mb-3">
                <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                <input
                  type="text"
                  placeholder={s.settings_searchPlaceholder}
                  value={vendorSearch}
                  onChange={(e) => setVendorSearch(e.target.value)}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>

              <div className="mb-4 grid grid-cols-3 gap-2">
                {(
                  [
                    ["attention", s.admin_show_flagged_only],
                    ["green_ready", s.admin_show_green_ready],
                    ["all", s.admin_show_all_vendors],
                  ] as [AdminVendorListFilter, string][]
                ).map(([filterKey, label]) => (
                  <button
                    key={filterKey}
                    type="button"
                    data-testid={`admin-vendor-filter-${filterKey}`}
                    onClick={() => setVendorListFilter(filterKey)}
                    className={cn(
                      "rounded-xl border py-2.5 px-1 text-xs font-semibold active:scale-[0.98] transition-transform",
                      vendorListFilter === filterKey
                        ? "border-brand bg-brand/10 text-brand"
                        : "border-border text-foreground",
                    )}
                  >
                    {filterKey === "green_ready" && adminStats.greenPendingVendors > 0
                      ? `${label} (${adminStats.greenPendingVendors})`
                      : label}
                  </button>
                ))}
              </div>

              <div className="space-y-3 max-h-96 overflow-y-auto">
                {filteredVendors.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {s.settings_noVendorsFound}
                  </p>
                )}
                {filteredVendors.map((v) => (
                  <div
                    key={v.id}
                    id={`admin-vendor-${v.id}`}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-2xl border border-border p-3 transition-shadow",
                      flashVendorId === v.id && "ring-2 ring-brand shadow-md",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold truncate">{v.shop_name}</p>
                        {v.is_active && (
                          <span className="text-[10px] text-green-500 font-semibold">
                            {s.settings_live}
                          </span>
                        )}
                        <AdminTrustLevelBadge level={v.trustLevel} />
                        {v.is_banned && (
                          <span className="rounded-full bg-destructive/10 text-destructive text-[10px] font-bold px-2 py-0.5 border border-destructive/30">
                            BANNED
                          </span>
                        )}
                      </div>
                      <AdminVendorTypeLabel vendorType={v.vendor_type} />
                      <AdminVendorCategoryChips
                        categories={v.categories}
                        fallbackLabel={v.category}
                        getLabel={getLabel}
                      />
                      <p className="text-xs text-muted-foreground truncate mt-1">{v.name}</p>
                      <p className="text-xs text-muted-foreground">{v.phone}</p>
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                      {v.categories.some((c) => !c.is_manual_verified) &&
                        hasVerifyInProgress(v.id) && (
                        <span className="rounded-full bg-amber-500/10 text-amber-600 text-[10px] font-semibold px-2 py-0.5 border border-amber-500/30">
                          In progress
                        </span>
                      )}
                      <div className="flex flex-wrap justify-end gap-1 max-w-[11rem]">
                        {v.categories.map((cat, idx) => {
                          const key = cat.category_id
                            ? `${v.id}:${cat.category_id}`
                            : `${v.id}:${idx}`;
                          const busy = verifying === key || verifying === v.id;
                          return (
                            <button
                              key={key}
                              type="button"
                              title={getLabel(cat.label)}
                              onClick={() =>
                                cat.is_manual_verified
                                  ? void confirmUnverifyCategory(v.id, cat.category_id)
                                  : openVerifySheet(v, cat)
                              }
                              disabled={busy || (!cat.category_id && !cat.is_manual_verified)}
                              className={`flex items-center gap-1 rounded-xl px-2 py-1 text-[10px] font-semibold transition-colors ${
                                cat.is_manual_verified
                                  ? "bg-green-500/10 text-green-500 border border-green-500/30"
                                  : "bg-destructive/10 text-destructive border border-destructive/30"
                              }`}
                            >
                              {busy ? (
                                s.settings_btnLoading
                              ) : cat.is_manual_verified ? (
                                <>
                                  <CheckCircle className="h-3 w-3" /> {cat.emoji}
                                </>
                              ) : (
                                <>
                                  <XCircle className="h-3 w-3" /> {cat.emoji}
                                </>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      {!v.is_banned ? (
                        <button
                          type="button"
                          onClick={() => {
                            setVendorBanReason("");
                            setVendorBanDialog({ open: true, vendor: v });
                          }}
                          disabled={vendorBanAction === v.id}
                          className="rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Ban
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void unbanVendor(v.id)}
                          disabled={vendorBanAction === v.id}
                          className="rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Unban
                        </button>
                      )}
                      {v.deletion_requested_at ? (
                        <button
                          type="button"
                          data-testid="admin-force-clear-deletion"
                          onClick={() => {
                            setVendorClearDeletionReason("");
                            setVendorClearDeletionDialog({ open: true, vendor: v });
                          }}
                          disabled={vendorBanAction === v.id}
                          className="rounded-xl bg-amber-500/10 text-amber-700 border border-amber-500/30 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                        >
                          Clear deletion
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>

              {vendorListHasMore && (
                <button
                  type="button"
                  disabled={vendorListLoading}
                  onClick={() => void loadVendorList({ append: true })}
                  className="mt-4 w-full rounded-xl border border-border py-2.5 text-xs font-semibold text-foreground disabled:opacity-50 active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
                >
                  {vendorListLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      {s.settings_btnLoading}
                    </>
                  ) : (
                    s.admin_load_more
                  )}
                </button>
              )}
            </div>

            <div className="mx-4 border-t border-surface-border" />

            <div className="px-4 py-3 border-b border-surface-border">
              <p className="text-sm font-medium text-foreground">
                Flagged Users ({flaggedUsers.length})
              </p>
            </div>
            <div className="px-4 py-3">
              {flaggedUsers.length === 0 ? (
                <p className="text-sm text-muted-foreground">✅ No flagged users at this time</p>
              ) : (
                <div className="space-y-3">
                  {flaggedUsers.map((user) => {
                    const warnCount = user.warn_count ?? 0;
                    const highWarns = warnCount >= 3;
                    return (
                      <div
                        key={user.phone}
                        className={`rounded-2xl border p-3 space-y-2 ${
                          highWarns
                            ? "border-amber-500/50 bg-amber-500/5"
                            : "border-border"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold">{user.phone}</p>
                          {warnCount > 0 && (
                            <span className="rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 text-[10px] font-semibold px-2 py-0.5 border border-amber-500/30">
                              ⚠️ {warnCount} warns
                            </span>
                          )}
                          {user.is_banned && (
                            <span className="rounded-full bg-destructive/10 text-destructive text-[10px] font-bold px-2 py-0.5 border border-destructive/30">
                              BANNED
                            </span>
                          )}
                        </div>
                        {highWarns && (
                          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                            {s.admin_consider_banning}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          Trust score:{" "}
                          <span className={`font-semibold ${trustScoreClass(user.trust_score)}`}>
                            {user.trust_score}
                          </span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {user.noshow_count} no-shows, {user.fake_count} fakes
                        </p>
                        {user.is_banned && user.ban_reason && (
                          <p className="text-[11px] text-destructive/80">{user.ban_reason}</p>
                        )}
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void warnFlaggedUser(user.phone)}
                            disabled={flaggedAction === user.phone}
                            className="flex-1 rounded-xl bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                          >
                            Warn
                          </button>
                          {!user.is_banned && (
                            <button
                              type="button"
                              onClick={() => {
                                setBanReason("");
                                setBanDialog({ open: true, phone: user.phone });
                              }}
                              disabled={flaggedAction === user.phone}
                              className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                            >
                              Ban
                            </button>
                          )}
                          {user.is_banned && (
                            <button
                              type="button"
                              onClick={() => void unbanFlaggedUser(user.phone)}
                              disabled={flaggedAction === user.phone}
                              className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                            >
                              Unban
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_pendingCategories} (${pendingCategories.length})`}
            open={pendingCatOpen}
            onToggle={() => setPendingCatOpen((o) => !o)}
          >
            {pendingCategories.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noPendingCategories}</p>
            ) : (
              <div className="space-y-3">
                {pendingCategories.map((cat) => (
                  <div
                    key={cat.id}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg" aria-hidden>
                        {cat.emoji}
                      </span>
                      <p className="text-sm font-semibold">{cat.label}</p>
                      <span className="rounded-full bg-secondary/10 text-secondary text-[10px] font-semibold px-2 py-0.5 border border-secondary/30">
                        {getServiceModeLabel(cat.service_mode)}
                      </span>
                      {cat.ai_confidence && (
                        <span
                          className={`rounded-full text-[10px] font-semibold px-2 py-0.5 ${confidenceBadgeClass(cat.ai_confidence, cat.ai_confidence_score)}`}
                        >
                          {cat.ai_confidence_score != null
                            ? `${Math.round(cat.ai_confidence_score * 100)}%`
                            : cat.ai_confidence}
                        </span>
                      )}
                      {cat.suggestion_count > 0 && (
                        <span className="rounded-full bg-muted text-muted-foreground text-[10px] font-semibold px-2 py-0.5 border border-border">
                          {s.admin_suggestion_count_label}: {cat.suggestion_count}
                        </span>
                      )}
                    </div>
                    {cat.ai_reasoning && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {cat.ai_reasoning}
                      </p>
                    )}
                    {cat.ai_service_mode_reasoning && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-semibold text-foreground/80">
                          {s.admin_mode_reasoning_label}:{" "}
                        </span>
                        {cat.ai_service_mode_reasoning}
                      </p>
                    )}
                    {cat.proposed_aliases.length > 0 && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-semibold text-foreground/80">
                          {s.admin_proposed_aliases_label}:{" "}
                        </span>
                        {cat.proposed_aliases.join(", ")}
                      </p>
                    )}
                    {(cat.overlap_category_label || cat.overlap_reasoning) && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                        <span className="font-semibold">
                          {s.admin_overlap_label}
                          {cat.overlap_category_label
                            ? ` → ${cat.overlap_category_label}`
                            : ""}
                          :{" "}
                        </span>
                        {cat.overlap_reasoning ?? ""}
                      </p>
                    )}
                    {cat.license_type && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        <span className="font-semibold text-foreground/80">
                          {s.admin_license_type_label}:{" "}
                        </span>
                        {cat.license_type}
                        {cat.license_confidence_score != null
                          ? ` (${Math.round(cat.license_confidence_score * 100)}%)`
                          : ""}
                        {cat.license_review_status
                          ? ` · ${cat.license_review_status}`
                          : ""}
                        {cat.license_reasoning ? ` — ${cat.license_reasoning}` : ""}
                      </p>
                    )}
                    {cat.suggested_vendor_name && (
                      <p className="text-[10px] text-muted-foreground">
                        Suggested by {cat.suggested_vendor_name}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {s.admin_approve_as_new_hint}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void approvePendingCategory(cat)}
                        disabled={pendingAction === cat.id}
                        className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ✅ {s.admin_approve}
                      </button>
                      <button
                        type="button"
                        onClick={() => void openMergeCategoryDialog(cat)}
                        disabled={pendingAction === cat.id}
                        className="flex-1 rounded-xl bg-amber-500/10 text-amber-800 border border-amber-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        🔗 {s.admin_merge_as_alias}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectCategoryDialog({ open: true, cat })}
                        disabled={pendingAction === cat.id}
                        className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ❌ {s.admin_reject}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_pendingLicenses} (${pendingLicenses.length})`}
            open={pendingLicenseOpen}
            onToggle={() => setPendingLicenseOpen((o) => !o)}
          >
            <button
              type="button"
              data-testid="admin-license-backfill"
              onClick={() => void runLicenseBackfill()}
              disabled={licenseBackfillRunning}
              className="mb-3 w-full rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
            >
              {licenseBackfillRunning ? s.admin_license_backfill_running : s.admin_license_backfill}
            </button>
            {pendingLicenses.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noPendingLicenses}</p>
            ) : (
              <div className="space-y-3">
                {pendingLicenses.map((row) => (
                  <div
                    key={row.id}
                    data-testid={`pending-license-card-${row.id}`}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg" aria-hidden>
                        {row.emoji}
                      </span>
                      <p className="text-sm font-semibold">{row.label}</p>
                      <span className="rounded-full bg-secondary/10 text-secondary text-[10px] font-semibold px-2 py-0.5 border border-secondary/30">
                        {row.license_type ?? s.admin_generic_license}
                      </span>
                      {row.license_confidence_score != null &&
                        Number.isFinite(row.license_confidence_score) && (
                          <span
                            className={`rounded-full text-[10px] font-semibold px-2 py-0.5 ${confidenceBadgeClass(null, row.license_confidence_score)}`}
                          >
                            {Math.round(row.license_confidence_score * 100)}%
                          </span>
                        )}
                    </div>
                    {row.license_reasoning && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {row.license_reasoning}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {s.admin_license_approve_hint}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void approvePendingLicense(row)}
                        disabled={pendingLicenseAction === row.id}
                        className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ✅ {s.admin_approve_license}
                      </button>
                      <button
                        type="button"
                        onClick={() => void rejectPendingLicense(row)}
                        disabled={pendingLicenseAction === row.id}
                        className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ❌ {s.admin_reject_license}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_pendingAliases} (${pendingAliases.length})`}
            open={pendingAliasOpen}
            onToggle={() => setPendingAliasOpen((o) => !o)}
          >
            {pendingAliases.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noPendingAliases}</p>
            ) : (
              <div className="space-y-3">
                {pendingAliases.map((row) => (
                  <div
                    key={row.id}
                    data-testid={`pending-alias-card-${row.id}`}
                    data-alias-term={row.term}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{row.term}</p>
                      <span className="text-lg" aria-hidden>
                        {row.category_emoji}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {row.category_label}
                      </span>
                      {row.confidence != null && Number.isFinite(row.confidence) && (
                        <span
                          className={`rounded-full text-[10px] font-semibold px-2 py-0.5 ${confidenceBadgeClass(null, row.confidence)}`}
                        >
                          {Math.round(row.confidence * 100)}%
                        </span>
                      )}
                      <span
                        className={`rounded-full text-[10px] font-semibold px-2 py-0.5 border ${
                          row.source === "corrective_ai"
                            ? "bg-amber-500/10 text-amber-800 border-amber-500/30 dark:text-amber-400"
                            : row.source === "proactive_ai"
                              ? "bg-sky-500/10 text-sky-800 border-sky-500/30 dark:text-sky-400"
                              : "bg-muted text-muted-foreground border-border"
                        }`}
                      >
                        {row.source === "corrective_ai"
                          ? s.admin_pending_alias_source_corrective
                          : row.source === "proactive_ai"
                            ? s.admin_pending_alias_source_proactive
                            : row.source === "manual"
                              ? s.admin_pending_alias_source_manual
                              : row.source}
                      </span>
                    </div>
                    {row.ai_reasoning && (
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {row.ai_reasoning}
                      </p>
                    )}
                    {row.suggested_vendor_name && (
                      <p className="text-[10px] text-muted-foreground">
                        {s.admin_pending_alias_source}: {row.suggested_vendor_name}
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      {row.source === "corrective_ai"
                        ? s.admin_pending_alias_corrective_hint
                        : s.admin_pending_alias_approve_hint}
                    </p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        onClick={() => void approvePendingAlias(row)}
                        disabled={pendingAliasAction === row.id}
                        className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ✅ {s.admin_approve_alias}
                      </button>
                      <button
                        type="button"
                        onClick={() => void rejectPendingAlias(row)}
                        disabled={pendingAliasAction === row.id}
                        className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ❌ {s.admin_reject_alias}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_pendingBusinesses} (${pendingVendorBusinesses.length})`}
            open={pendingBusinessOpen}
            onToggle={() => setPendingBusinessOpen((o) => !o)}
          >
            {pendingVendorBusinesses.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noPendingBusinesses}</p>
            ) : (
              <div className="space-y-3">
                {pendingVendorBusinesses.map((row) => (
                  <div
                    key={row.vendor_category_id}
                    data-testid={`pending-business-card-${row.vendor_category_id}`}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">
                        {row.shop_name ?? row.vendor_name ?? "Vendor"}
                      </p>
                      {row.vendor_phone && (
                        <span className="text-[10px] text-muted-foreground">{row.vendor_phone}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground/80">
                        {s.admin_pending_business_new}:{" "}
                      </span>
                      <span aria-hidden>{row.category_emoji}</span> {row.category_label}
                      {row.brand_name ? ` · ${row.brand_name}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      <span className="font-semibold text-foreground/80">
                        {s.admin_pending_business_existing}:{" "}
                      </span>
                      {row.approved_businesses.length === 0
                        ? "—"
                        : row.approved_businesses
                            .map(
                              (b) =>
                                `${b.emoji ?? ""} ${b.label}${b.brand_name ? ` (${b.brand_name})` : ""}`.trim(),
                            )
                            .join(" · ")}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{s.admin_pending_business_hint}</p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <button
                        type="button"
                        data-testid={`pending-business-approve-${row.vendor_category_id}`}
                        onClick={() => void approvePendingVendorBusiness(row)}
                        disabled={pendingBusinessAction === row.vendor_category_id}
                        className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ✅ {s.admin_approve}
                      </button>
                      <button
                        type="button"
                        data-testid={`pending-business-reject-${row.vendor_category_id}`}
                        onClick={() =>
                          setRejectBusinessDialog({ open: true, row, reason: "" })
                        }
                        disabled={pendingBusinessAction === row.vendor_category_id}
                        className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        ❌ {s.admin_reject}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_modeConfidenceReview} (${modeConfidenceReviews.length})`}
            open={modeConfidenceOpen}
            onToggle={() => setModeConfidenceOpen((o) => !o)}
          >
            {modeConfidenceReviews.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_noModeConfidenceReviews}</p>
            ) : (
              <div className="space-y-3">
                {modeConfidenceReviews.map((row) => {
                  const defaultKey = `${row.id}:${row.current_default_mode}`;
                  const proposedKey = `${row.id}:${row.proposed_mode}`;
                  return (
                    <div
                      key={row.id}
                      data-testid={`mode-confidence-card-${row.id}`}
                      className="rounded-2xl border border-border p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg" aria-hidden>
                          {row.category_emoji}
                        </span>
                        <p className="text-sm font-semibold">{row.category_label}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {s.admin_modeConfidence_currentDefault}:{" "}
                        <span className="font-semibold text-foreground">
                          {getServiceModeLabel(row.current_default_mode)}
                        </span>
                        {" → "}
                        {s.admin_modeConfidence_proposed}:{" "}
                        <span className="font-semibold text-foreground">
                          {getServiceModeLabel(row.proposed_mode)}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {s.admin_modeConfidence_split}:{" "}
                        <span className="font-semibold text-foreground">
                          {getServiceModeLabel(row.current_default_mode)}{" "}
                          {row.default_mode_vendor_count}
                        </span>
                        {" / "}
                        <span className="font-semibold text-foreground">
                          {getServiceModeLabel(row.proposed_mode)}{" "}
                          {row.proposed_mode_vendor_count}
                        </span>
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {s.admin_modeConfidence_hint}
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          data-testid={`mode-confidence-view-default-${row.id}`}
                          onClick={() =>
                            void loadModeConfidenceVendorSide(
                              row.id,
                              row.category_id,
                              row.current_default_mode,
                            )
                          }
                          disabled={modeConfidenceVendorsLoading === defaultKey}
                          className="flex-1 rounded-xl bg-muted text-foreground border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          {modeConfidenceExpanded === defaultKey
                            ? s.admin_modeConfidence_hideVendors
                            : `${s.admin_modeConfidence_viewVendors} (${getServiceModeLabel(row.current_default_mode)})`}
                        </button>
                        <button
                          type="button"
                          data-testid={`mode-confidence-view-proposed-${row.id}`}
                          onClick={() =>
                            void loadModeConfidenceVendorSide(
                              row.id,
                              row.category_id,
                              row.proposed_mode,
                            )
                          }
                          disabled={modeConfidenceVendorsLoading === proposedKey}
                          className="flex-1 rounded-xl bg-muted text-foreground border border-border px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          {modeConfidenceExpanded === proposedKey
                            ? s.admin_modeConfidence_hideVendors
                            : `${s.admin_modeConfidence_viewVendors} (${getServiceModeLabel(row.proposed_mode)})`}
                        </button>
                      </div>
                      {modeConfidenceExpanded &&
                        modeConfidenceExpanded.startsWith(`${row.id}:`) &&
                        modeConfidenceVendors[modeConfidenceExpanded] && (
                          <div
                            className="rounded-xl border border-border bg-background/60 p-2 space-y-1"
                            data-testid={`mode-confidence-vendor-list-${row.id}`}
                          >
                            {modeConfidenceVendors[modeConfidenceExpanded].length === 0 ? (
                              <p className="text-xs text-muted-foreground">No vendors</p>
                            ) : (
                              modeConfidenceVendors[modeConfidenceExpanded].map((v, idx) => (
                                <div
                                  key={`${v.phone ?? "x"}-${idx}`}
                                  className="flex items-center justify-between gap-2 text-xs"
                                >
                                  <div className="min-w-0">
                                    <p className="font-medium truncate">
                                      {v.shop_name || "Vendor"}
                                    </p>
                                    <p className="text-muted-foreground">{v.phone || "—"}</p>
                                  </div>
                                  {v.phone && (
                                    <button
                                      type="button"
                                      onClick={() => openVendorInAdminList(v.phone)}
                                      className="shrink-0 rounded-lg border border-border px-2 py-1 text-[10px] font-semibold"
                                    >
                                      {s.admin_modeConfidence_openInList}
                                    </button>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                          type="button"
                          data-testid={`mode-confidence-confirm-${row.id}`}
                          onClick={() => void confirmModeConfidenceReview(row)}
                          disabled={modeConfidenceAction === row.id}
                          className="flex-1 rounded-xl bg-green-500/10 text-green-700 border border-green-500/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          ✅ {s.admin_modeConfidence_updateDefault}
                        </button>
                        <button
                          type="button"
                          data-testid={`mode-confidence-dismiss-${row.id}`}
                          onClick={() => void dismissModeConfidenceReview(row)}
                          disabled={modeConfidenceAction === row.id}
                          className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                        >
                          ❌ {s.admin_modeConfidence_dismiss}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_recommendations_title} (${recommendations.length})`}
            open={recommendationsOpen}
            onToggle={() => setRecommendationsOpen((o) => !o)}
          >
            <div className="px-4 pt-3">
              <button
                type="button"
                onClick={() => setShowRemovedRecs((v) => !v)}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  showRemovedRecs
                    ? "bg-primary/10 text-primary border-primary/30"
                    : "bg-muted text-muted-foreground border-border"
                }`}
              >
                {s.admin_rec_show_removed}
              </button>
            </div>
            {recommendationsLoading ? (
              <p className="text-sm text-muted-foreground px-4 py-3">{s.feed_loadingAria}</p>
            ) : recommendations.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3">{s.admin_recommendations_empty}</p>
            ) : (
              <div className="space-y-3 px-4 py-3">
                {recommendations.map((rec) => {
                  const vendorLabel =
                    rec.recommended_vendor_name?.trim() ||
                    (rec.recommended_vendor_phone
                      ? maskPhoneLast4(rec.recommended_vendor_phone)
                      : "—");
                  const reachKm =
                    rec.reach_radius_km != null && rec.reach_radius_km > 0
                      ? `${rec.reach_radius_km} km`
                      : "5 km";
                  const isLead = rec.recommended_vendor_id == null;
                  const isDismissed = rec.admin_dismissed_at != null;
                  const isContacted = rec.admin_contacted_at != null;
                  return (
                    <div
                      key={rec.id}
                      className="rounded-2xl border border-surface-border p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {isLead && isContacted && (
                          <span className="inline-flex items-center rounded-full bg-green-500/10 text-green-700 dark:text-green-400 border border-green-500/30 px-2 py-0.5 text-[10px] font-semibold">
                            ✓ {s.admin_rec_contacted}
                          </span>
                        )}
                        {isLead && showRemovedRecs && isDismissed && (
                          <span className="inline-flex items-center rounded-full bg-destructive/10 text-destructive border border-destructive/30 px-2 py-0.5 text-[10px] font-semibold">
                            {s.admin_rec_removed_label}
                          </span>
                        )}
                        {isLead && showRemovedRecs && !isDismissed && rec.vendor_onboarded && (
                          <span className="inline-flex items-center rounded-full bg-primary/10 text-primary border border-primary/30 px-2 py-0.5 text-[10px] font-semibold">
                            {s.admin_rec_onboarded_label}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-foreground">{rec.content}</p>
                      <div className="grid grid-cols-1 gap-1 text-xs text-muted-foreground">
                        <p>
                          {s.admin_recommendations_poster}: {maskPhoneLast4(rec.user_phone)}
                        </p>
                        <p>
                          {s.admin_recommendations_vendor}: {vendorLabel}
                        </p>
                        <p>
                          {s.admin_recommendations_reach}: {reachKm}
                        </p>
                        <p>
                          {s.admin_recommendations_expires}:{" "}
                          {rec.expires_at
                            ? new Date(rec.expires_at).toLocaleString()
                            : "—"}
                        </p>
                        <p>{new Date(rec.created_at).toLocaleString()}</p>
                      </div>
                      {isLead && (
                        <div className="flex gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => void markRecommendationContacted(rec, !isContacted)}
                            disabled={recActionId === rec.id}
                            className={`flex-1 rounded-xl border px-3 py-2 text-xs font-semibold disabled:opacity-50 ${
                              isContacted
                                ? "bg-green-500/10 text-green-700 border-green-500/30"
                                : "bg-muted text-foreground border-border"
                            }`}
                          >
                            {isContacted ? "✓ " : ""}
                            {s.admin_rec_contacted}
                          </button>
                          {isDismissed ? (
                            <button
                              type="button"
                              onClick={() => void restoreRecommendation(rec)}
                              disabled={recActionId === rec.id}
                              className="flex-1 rounded-xl bg-primary/10 text-primary border border-primary/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                            >
                              {s.admin_rec_restore}
                            </button>
                          ) : rec.vendor_onboarded ? null : (
                            <button
                              type="button"
                              onClick={() => void dismissRecommendation(rec)}
                              disabled={recActionId === rec.id}
                              className="flex-1 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                            >
                              {s.admin_rec_remove}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={`${s.admin_lowRatings_title} (${lowRatings.length})`}
            open={lowRatingsOpen}
            onToggle={() => setLowRatingsOpen((o) => !o)}
          >
            {lowRatings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{s.admin_lowRatings_empty}</p>
            ) : (
              <div className="space-y-3">
                {lowRatings.map((review) => (
                  <div
                    key={review.id}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-semibold">{review.shop_name}</p>
                        <p className="text-sm" aria-label={`${review.rating} stars`}>
                          {"⭐".repeat(review.rating)}
                          {"☆".repeat(Math.max(0, 5 - review.rating))}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {review.review_text?.trim()
                            ? `"${review.review_text.trim()}"`
                            : s.admin_lowRatings_noComment}
                        </p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {review.user_phone?.trim()
                            ? maskPhoneLast4(review.user_phone.trim())
                            : "—"}
                          {" · "}
                          {new Date(review.created_at).toLocaleDateString("en-IN", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setReviewDeleteDialog({ open: true, review })}
                        disabled={lowRatingDeletingId === review.id}
                        className="shrink-0 rounded-xl bg-destructive/10 text-destructive border border-destructive/30 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        {lowRatingDeletingId === review.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin inline" />
                        ) : (
                          s.admin_lowRatings_delete
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsCollapsible>

          <SettingsCollapsible
            label={s.admin_sub_panel}
            open={subOverviewOpen}
            onToggle={() => {
              setSubOverviewOpen((o) => {
                const next = !o;
                if (next && subVendors.length === 0) void loadSubVendors();
                return next;
              });
            }}
          >
            <div className="space-y-3">
              {subNetworkStatus && (
                <NetworkErrorBanner
                  status={subNetworkStatus}
                  className="mb-0"
                  onRetry={
                    subNetworkStatus === "failed" ? () => void loadSubVendors() : undefined
                  }
                />
              )}
              {subLoading && !subNetworkStatus && (
                <p className="text-sm text-muted-foreground">Loading subscription data…</p>
              )}
              {!subLoading && subNetworkStatus !== "failed" && subVendors.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No vendors currently in grace/expired/cancelled state.
                </p>
              )}
              {!subLoading &&
                subNetworkStatus !== "failed" &&
                subVendors.map((v) => {
                  const phoneLabel = v.phone ? maskPhoneLast4(v.phone) : "—";
                  const status = v.subscription_status;
                  let badgeClass =
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold border";
                  if (status === "grace") {
                    badgeClass +=
                      " bg-amber-500/10 text-amber-700 border-amber-500/30";
                  } else if (status === "expired") {
                    badgeClass +=
                      " bg-destructive/10 text-destructive border-destructive/30";
                  } else {
                    badgeClass +=
                      " bg-muted text-muted-foreground border-border";
                  }
                  const refDate =
                    status === "grace" || status === "expired"
                      ? v.grace_ends_at
                      : null;
                  const whenLabel =
                    status === "grace"
                      ? `Grace ends: ${formatAdminDate(v.grace_ends_at)}`
                      : status === "expired"
                        ? `Expired: ${formatAdminDate(v.grace_ends_at)}`
                        : "Cancelled";
                  return (
                    <div
                      key={v.id}
                      className="rounded-2xl border border-border p-3 space-y-1"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{v.shop_name}</p>
                          <p className="text-xs text-muted-foreground tabular-nums">
                            {phoneLabel}
                          </p>
                        </div>
                        <span className={badgeClass}>{status}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{whenLabel}</p>
                      {refDate && (
                        <p className="text-[10px] text-muted-foreground">
                          {daysAgo(refDate)}
                        </p>
                      )}
                    </div>
                  );
                })}

              <div className="mt-2 rounded-2xl border border-border p-3 space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">
                  Set Waive-off (per vendor)
                </p>
                <input
                  type="tel"
                  placeholder="Vendor phone"
                  value={waivePhone}
                  onChange={(e) => setWaivePhone(e.target.value)}
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                />
                <div className="flex gap-2">
                  <input
                    type="number"
                    min={1}
                    max={100}
                    placeholder="%"
                    value={waivePercent}
                    onChange={(e) => setWaivePercent(e.target.value)}
                    className="w-1/2 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                  />
                  <input
                    type="number"
                    min={1}
                    max={12}
                    placeholder="Months"
                    value={waiveMonths}
                    onChange={(e) => setWaiveMonths(e.target.value)}
                    className="w-1/2 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                  />
                </div>
                <button
                  type="button"
                  disabled={waiveSubmitting}
                  onClick={async () => {
                    const phone = waivePhone.trim();
                    const percent = Number(waivePercent);
                    const months = Number(waiveMonths);
                    if (!phone || !Number.isFinite(percent) || !Number.isFinite(months)) {
                      toast.error("Phone, percent and months are required");
                      return;
                    }
                    if (percent <= 0 || percent > 100 || months <= 0 || months > 12) {
                      toast.error("Percent 1–100, months 1–12");
                      return;
                    }
                    const { data: vendorRow, error: vErr } = await supabase
                      .from("vendors")
                      .select("id, phone, shop_name")
                      .eq("phone", phone)
                      .maybeSingle();
                    if (vErr || !vendorRow) {
                      toast.error("Vendor not found for that phone");
                      return;
                    }
                    setWaiveConfirm({
                      open: true,
                      vendor: {
                        id: vendorRow.id as string,
                        shop_name:
                          (vendorRow.shop_name as string | null)?.trim() || "Vendor",
                        phone: (vendorRow.phone as string | null) ?? null,
                      },
                      percent,
                      months,
                    });
                  }}
                  className="w-full rounded-xl bg-brand text-brand-foreground py-2.5 text-sm font-semibold active:scale-[0.99] disabled:opacity-50"
                >
                  {waiveSubmitting ? "Applying…" : "Apply Waive-off"}
                </button>
              </div>
            </div>
          </SettingsCollapsible>

          <SettingsCollapsible
            label={s.admin_app_config}
            open={adminConfigOpen}
            onToggle={() => setAdminConfigOpen((o) => !o)}
          >
            <div className="space-y-3">
              {ADMIN_CONFIG_WHITELIST.map((key) => {
                const configType = getAdminConfigType(key);
                const value = adminConfigDraft[key] ?? adminConfigValues[key] ?? "";
                return (
                  <div
                    key={key}
                    className="rounded-2xl border border-border p-3 space-y-2"
                  >
                    <p className="text-xs font-semibold text-muted-foreground">
                      {ADMIN_CONFIG_LABELS[key]}
                    </p>
                    <p
                      className="text-[11px] text-muted-foreground"
                      data-testid={`admin-config-default-${key}`}
                    >
                      {s.admin_config_default(
                        formatAdminConfigDefaultLabel(
                          adminConfigDefaults[key] ?? ADMIN_CONFIG_FALLBACK_DEFAULTS[key],
                        ),
                      )}
                    </p>
                    {configType === "boolean" ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm text-muted-foreground">
                          {parseAdminConfigBoolean(value) ? "Enabled" : "Disabled"}
                        </span>
                        <Switch
                          checked={parseAdminConfigBoolean(value)}
                          disabled={adminConfigSaving === key}
                          onCheckedChange={(checked) =>
                            void saveAdminConfigKey(key, checked ? "true" : "false")
                          }
                        />
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex gap-2">
                          <input
                            type={configType === "number" ? "number" : "text"}
                            value={value}
                            onChange={(e) => {
                              setAdminConfigDraft((prev) => ({ ...prev, [key]: e.target.value }));
                              if (adminConfigErrors[key]) {
                                setAdminConfigErrors((prev) => {
                                  const next = { ...prev };
                                  delete next[key];
                                  return next;
                                });
                              }
                            }}
                            className="flex-1 min-w-0 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary"
                          />
                          <button
                            type="button"
                            disabled={adminConfigSaving === key}
                            onClick={() => void saveAdminConfigKey(key)}
                            className="shrink-0 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground disabled:opacity-50"
                          >
                            {adminConfigSaving === key ? "…" : "Save"}
                          </button>
                        </div>
                        {adminConfigErrors[key] ? (
                          <p className="text-xs text-destructive">{adminConfigErrors[key]}</p>
                        ) : null}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </SettingsCollapsible>

          <AlertDialog
            open={reviewDeleteDialog.open}
            onOpenChange={(open) => {
              if (!open) setReviewDeleteDialog({ open: false, review: null });
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>{s.admin_lowRatings_deleteConfirmTitle}</AlertDialogTitle>
                <AlertDialogDescription>
                  {reviewDeleteDialog.review
                    ? s.admin_lowRatings_deleteConfirmBody.replace(
                        "{stars}",
                        "★".repeat(reviewDeleteDialog.review.rating),
                      )
                    : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!reviewDeleteDialog.review || lowRatingDeletingId !== null}
                  onClick={() => {
                    const row = reviewDeleteDialog.review;
                    setReviewDeleteDialog({ open: false, review: null });
                    if (row) void deleteLowRating(row);
                  }}
                >
                  {s.admin_lowRatings_delete}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={vendorBanDialog.open}
            onOpenChange={(open) => {
              if (!open) {
                setVendorBanDialog({ open: false, vendor: null });
                setVendorBanReason("");
              }
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Ban this vendor?</AlertDialogTitle>
                <AlertDialogDescription>
                  Enter a reason for the ban. The vendor will be notified immediately.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="text"
                value={vendorBanReason}
                onChange={(e) => setVendorBanReason(e.target.value.slice(0, 200))}
                placeholder="Ban reason"
                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!vendorBanReason.trim() || vendorBanAction != null}
                  onClick={(e) => {
                    e.preventDefault();
                    void confirmBanVendor();
                  }}
                >
                  Confirm ban
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={vendorClearDeletionDialog.open}
            onOpenChange={(open) => {
              if (!open) {
                setVendorClearDeletionDialog({ open: false, vendor: null });
                setVendorClearDeletionReason("");
              }
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Force-clear scheduled deletion?</AlertDialogTitle>
                <AlertDialogDescription>
                  This immediately restores the vendor and skips the 30-day wait. A reason is
                  required for the audit log.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="text"
                data-testid="admin-force-clear-deletion-reason"
                value={vendorClearDeletionReason}
                onChange={(e) => setVendorClearDeletionReason(e.target.value.slice(0, 200))}
                placeholder="Reason (required)"
                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!vendorClearDeletionReason.trim() || vendorBanAction != null}
                  onClick={(e) => {
                    e.preventDefault();
                    void confirmForceClearDeletion();
                  }}
                >
                  Confirm clear
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={banDialog.open}
            onOpenChange={(open) => {
              if (!open) {
                setBanDialog({ open: false, phone: null });
                setBanReason("");
              }
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Ban this user?</AlertDialogTitle>
                <AlertDialogDescription>
                  Enter a reason for the ban. The user will be notified on their next order attempt.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="text"
                value={banReason}
                onChange={(e) => setBanReason(e.target.value.slice(0, 200))}
                placeholder="Ban reason"
                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!banReason.trim() || flaggedAction != null}
                  onClick={(e) => {
                    e.preventDefault();
                    void confirmBanUser();
                  }}
                >
                  Confirm ban
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={waiveConfirm.open}
            onOpenChange={(open) => {
              if (!open) setWaiveConfirm({ open: false, vendor: null, percent: 0, months: 0 });
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Apply this waive-off?</AlertDialogTitle>
                <AlertDialogDescription>
                  {waiveConfirm.vendor
                    ? `${waiveConfirm.vendor.shop_name} will get ${waiveConfirm.percent}% off for ${waiveConfirm.months} month${waiveConfirm.months === 1 ? "" : "s"}. The vendor will be notified immediately.`
                    : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!waiveConfirm.vendor || waiveSubmitting}
                  onClick={(e) => {
                    e.preventDefault();
                    void confirmApplyWaiveoff();
                  }}
                >
                  Confirm waive-off
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={rejectCategoryDialog.open}
            onOpenChange={(open) => {
              if (!open) setRejectCategoryDialog({ open: false, cat: null });
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>Reject this category?</AlertDialogTitle>
                <AlertDialogDescription>
                  {rejectCategoryDialog.cat
                    ? `"${rejectCategoryDialog.cat.label}" will stay inactive and the suggesting vendor will be notified.`
                    : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!rejectCategoryDialog.cat || pendingAction != null}
                  onClick={() => {
                    const cat = rejectCategoryDialog.cat;
                    setRejectCategoryDialog({ open: false, cat: null });
                    if (cat) void rejectPendingCategory(cat);
                  }}
                >
                  Confirm reject
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={rejectBusinessDialog.open}
            onOpenChange={(open) => {
              if (!open) setRejectBusinessDialog({ open: false, row: null, reason: "" });
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>{s.admin_pending_business_reject_title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {s.admin_pending_business_reject_body}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <input
                type="text"
                data-testid="pending-business-reject-reason"
                value={rejectBusinessDialog.reason}
                onChange={(e) =>
                  setRejectBusinessDialog((prev) => ({
                    ...prev,
                    reason: e.target.value.slice(0, 280),
                  }))
                }
                placeholder={s.admin_pending_business_reject_reason}
                className="w-full bg-background border border-border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={!rejectBusinessDialog.row || pendingBusinessAction != null}
                  onClick={() => {
                    const row = rejectBusinessDialog.row;
                    const reason = rejectBusinessDialog.reason;
                    setRejectBusinessDialog({ open: false, row: null, reason: "" });
                    if (row) void rejectPendingVendorBusiness(row, reason);
                  }}
                >
                  Confirm reject
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={mergeCategoryDialog.open}
            onOpenChange={(open) => {
              if (!open) setMergeCategoryDialog({ open: false, cat: null, targetId: "" });
            }}
          >
            <AlertDialogContent className="rounded-2xl border border-border bg-card">
              <AlertDialogHeader>
                <AlertDialogTitle>{s.admin_merge_pick_title}</AlertDialogTitle>
                <AlertDialogDescription>
                  {mergeCategoryDialog.cat
                    ? `“${mergeCategoryDialog.cat.label}” — ${s.admin_merge_pick_body}`
                    : s.admin_merge_pick_body}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="py-2">
                <select
                  className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm"
                  value={mergeCategoryDialog.targetId}
                  onChange={(e) =>
                    setMergeCategoryDialog((prev) => ({
                      ...prev,
                      targetId: e.target.value,
                    }))
                  }
                >
                  {mergeTargetOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {(opt.emoji ? `${opt.emoji} ` : "") + opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
                <AlertDialogCancel className="mt-0">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-amber-600 text-white hover:bg-amber-600/90"
                  disabled={
                    !mergeCategoryDialog.cat ||
                    !mergeCategoryDialog.targetId ||
                    pendingAction != null
                  }
                  onClick={() => void mergePendingCategoryAsAlias()}
                >
                  {s.admin_merge_confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.delete_account_confirm_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {dualRoleDelete
                ? s.deletion_dualRoleNotice
                : isVendor
                  ? s.delete_account_confirm_body
                  : s.delete_account_confirm_body_customer}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteAccountLoading}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteAccount();
              }}
            >
              {s.delete_account_confirm_action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearDataOpen} onOpenChange={setClearDataOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.settings_clearDataTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <ul className="list-disc space-y-2 pl-5 text-left">
                  <li>{s.settings_clearDataDescription_wiped}</li>
                  <li>{s.settings_clearDataDescription_permissions}</li>
                  <li>{s.settings_clearDataDescription_kept}</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="settings-clear-data-confirm"
              onClick={(e) => {
                e.preventDefault();
                setClearDataOpen(false);
                void reset();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {s.settings_clearDataConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteAddressId != null}
        onOpenChange={(open) => {
          if (!open) setDeleteAddressId(null);
        }}
      >
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.settings_deleteAddressTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.settings_deleteAddressBody}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0" disabled={deletingAddress}>
              {s.settings_cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deletingAddress}
              onClick={(e) => {
                e.preventDefault();
                void confirmDeleteAddress();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletingAddress ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {verifyBusinessPicker.open && verifyBusinessPicker.vendor && (
        <div className="fixed inset-0 z-50 flex items-end" data-testid="admin-verify-business-picker">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() =>
              setVerifyBusinessPicker({ open: false, vendor: null, mode: "verify" })
            }
          />
          <div className="relative w-full bg-card rounded-t-3xl p-5 shadow-xl">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-5" />
            <p className="font-display font-bold text-lg mb-3">{s.admin_verify_pick_business}</p>
            <div className="space-y-2">
              {(verifyBusinessPicker.mode === "verify"
                ? verifyBusinessPicker.vendor.categories.filter(
                    (c) => c.category_id && !c.is_manual_verified,
                  )
                : verifyBusinessPicker.vendor.categories.filter(
                    (c) => c.category_id && c.is_manual_verified,
                  )
              ).map((cat) => (
                <button
                  key={cat.category_id}
                  type="button"
                  className="w-full rounded-xl border border-border bg-muted/30 px-4 py-3 text-left text-sm font-semibold"
                  onClick={() => {
                    const picked = verifyBusinessPicker.vendor;
                    const mode = verifyBusinessPicker.mode;
                    setVerifyBusinessPicker({ open: false, vendor: null, mode: "verify" });
                    if (!picked) return;
                    if (mode === "verify") openVerifySheet(picked, cat);
                    else void confirmUnverifyCategory(picked.id, cat.category_id);
                  }}
                >
                  {cat.emoji} {getLabel(cat.label)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {verifySheet.open && verifySheet.vendor && (
        <div className="fixed inset-0 z-50 flex items-end">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeVerifySheet} />
          <div className="relative w-full bg-card rounded-t-3xl p-5 max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full mx-auto mb-5" />

            <div className="flex items-center gap-3 mb-1">
              <ShieldAlert className="h-5 w-5 text-secondary" />
              <p className="font-display font-bold text-lg">{s.settings_verifyVendor}</p>
            </div>
            <p className="text-sm text-muted-foreground mb-1">{verifySheet.vendor.shop_name}</p>
            <p className="text-xs text-muted-foreground mb-1">
              {verifySheet.vendor.name}
              {s.settings_dotSeparator}
              <a
                href={`tel:${verifySheet.vendor.phone.replace(/\s/g, "")}`}
                className="text-brand font-semibold hover:underline"
              >
                {verifySheet.vendor.phone}
              </a>
            </p>
            <p className="text-xs text-muted-foreground mb-1">
              {s.admin_verify_pick_business}:{" "}
              {verifySheet.category
                ? `${verifySheet.category.emoji} ${getLabel(verifySheet.category.label)}`
                : verifySheet.vendor.category}
            </p>
            <p className="text-xs text-muted-foreground mb-4">
              Service mode:{" "}
              {adminServiceModeLabel(
                verifySheet.category?.service_mode ?? verifySheet.vendor.service_mode,
              )}
            </p>

            <div className="rounded-2xl border border-border bg-muted/20 p-4 mb-5 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.admin_verification_checks_heading}
              </p>
              {TRUST_TIER_GROUPS.map((group) => {
                const vendorRows = verifySheet.vendor?.verifications ?? [];
                const openCat = verifySheet.category;
                const openCategoryId = openCat?.category_id ?? null;
                const openBizRows: BusinessLocationRow[] =
                  openCategoryId != null
                    ? [
                        {
                          vendor_id: verifySheet.vendor!.id,
                          category_id: openCategoryId,
                          shop_photo_url: openCat?.shop_photo_url ?? null,
                          gps_match_distance: openCat?.gps_match_distance ?? null,
                          location_accuracy: openCat?.location_accuracy ?? null,
                          photo_accuracy: openCat?.photo_accuracy ?? null,
                          verification_status: openCat?.verification_status ?? null,
                        },
                      ]
                    : [];
                const openTier = computeTrustLevelForBusiness(
                  verifySheet.vendor!.id,
                  openCategoryId,
                  vendorRows,
                  openBizRows,
                );
                const reached = tierReachedForBusiness(
                  verifySheet.vendor!.id,
                  openCategoryId,
                  vendorRows,
                  openBizRows,
                  group.tier,
                );
                const tierLabel =
                  group.tier === "Bronze"
                    ? s.trust_tier_bronze
                    : group.tier === "Silver"
                      ? s.trust_tier_silver
                      : group.tier === "Gold"
                        ? s.trust_tier_gold
                        : s.trust_tier_diamond;
                return (
                  <div
                    key={group.tier}
                    className="space-y-2"
                    data-testid={`admin-trust-tier-group-${group.tier.toLowerCase()}`}
                    data-tier-reached={reached ? "true" : "false"}
                    data-open-trust-level={openTier}
                    data-open-category-id={openCategoryId ?? undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {tierLabel}
                      </p>
                      <span
                        className={
                          reached
                            ? "text-[10px] font-semibold text-green-700 dark:text-green-400"
                            : "text-[10px] font-semibold text-muted-foreground"
                        }
                      >
                        {reached ? s.trust_tier_reached : s.trust_tier_not_reached}
                      </span>
                    </div>
                    {group.checks.map((checkType) => {
                      const meta = VERIFICATION_CHECK_BY_TYPE[checkType];
                      if (!meta) return null;
                      const status = statusForBusinessCheck(
                        checkType,
                        verifySheet.vendor!.id,
                        openCategoryId,
                        vendorRows,
                        openBizRows,
                      );
                      return (
                        <div
                          key={meta.check_type}
                          data-testid={`admin-check-row-${meta.check_type}`}
                          data-check-status={status}
                          className="flex items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-base shrink-0" aria-hidden>
                              {meta.icon}
                            </span>
                            <span className="text-sm text-foreground truncate">
                              {s[meta.labelKey]}
                            </span>
                          </div>
                          <span
                            className={cn(
                              "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize",
                              verificationStatusChipClass(status),
                            )}
                          >
                            {status === "coming_soon"
                              ? s.trust_check_coming_soon
                              : status}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            <div className="rounded-2xl border border-border bg-muted/30 p-4 mb-5 space-y-3 text-sm">
              {(() => {
                const payee = resolveAdminBusinessPayeeAndPin(verifySheet.category);
                if (!payee.hasBusiness) {
                  return (
                    <p className="text-sm text-muted-foreground" data-testid="admin-no-business-to-verify">
                      {s.admin_no_business_to_verify}
                    </p>
                  );
                }
                return (
                  <>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                  Shop photo
                </p>
                {payee.shopPhotoUrl ? (
                  <img
                    src={payee.shopPhotoUrl}
                    alt="Shop verification"
                    className="w-full h-[100px] object-cover rounded-xl border border-border"
                  />
                ) : (
                  <p className="text-xs text-muted-foreground rounded-xl border border-dashed border-border bg-muted/50 px-3 py-6 text-center">
                    No photo uploaded
                  </p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  GPS
                </p>
                {payee.latitude != null && payee.longitude != null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-foreground">
                      📍 {payee.latitude.toFixed(5)}, {payee.longitude.toFixed(5)}
                    </p>
                    <a
                      href={`https://maps.google.com/?q=${payee.latitude},${payee.longitude}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-brand hover:underline"
                    >
                      View on Map
                    </a>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No location set</p>
                )}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  GPS match
                </p>
                {(() => {
                  const { text, className } = gpsMatchAdminLabel(payee.gpsMatchDistance, {
                    locationAccuracy: verifySheet.category?.location_accuracy,
                    photoAccuracy: verifySheet.category?.photo_accuracy,
                    verificationStatus: verifySheet.category?.verification_status,
                  });
                  return <p className={cn("text-xs font-medium", className)}>{text}</p>;
                })()}
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  UPI ID
                </p>
                {payee.upiId ? (
                  <p className="text-xs text-foreground">💳 {payee.upiId}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">No UPI added</p>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">{s.admin_upi_manual_note}</p>
              </div>
                  </>
                );
              })()}
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Registered
                </p>
                <p className="text-xs text-foreground">
                  {formatVendorLastUpdated(verifySheet.vendor.last_updated)}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {s.referral_referred_by}
                </p>
                <p className="text-xs text-foreground">
                  {verifyReferrerLabel ?? "…"}
                </p>
              </div>
            </div>

            <p className="text-sm font-medium text-muted-foreground mb-4">
              {s.settings_verify_checks_progress.replace("{done}", String(totalCheckedCount))}
            </p>

            {[
              { id: "phone_called", label: s.settings_check1 },
              { id: "name_match", label: s.settings_check2 },
              { id: "aware", label: s.settings_check3 },
              { id: "shop_exists", label: s.settings_check4 },
              { id: "shop_name_match", label: s.settings_check5 },
              { id: "category_match", label: s.settings_check6 },
              { id: "service_mode_correct", label: s.settings_check7 },
              { id: "no_duplicate", label: s.settings_check8 },
              { id: "photo_genuine", label: s.settings_check9 },
              { id: "upi_verified", label: s.settings_check10 },
              { id: "no_suspicious", label: s.settings_check11 },
              { id: "rules_understood", label: s.settings_check12 },
              { id: "gps_photo_independent", label: s.admin_checklist_gps_photo },
            ].map((item) => (
              <label key={item.id} className="flex items-start gap-3 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!verifyChecks[item.id]}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    if (!verifySheet.vendor) return;
                    const progressId = verifySheet.category?.category_id
                      ? `${verifySheet.vendor.id}:${verifySheet.category.category_id}`
                      : verifySheet.vendor.id;
                    setVerifyChecks((prev) => {
                      const updated = { ...prev, [item.id]: checked };
                      localStorage.setItem(
                        verifyProgressKey(progressId),
                        JSON.stringify(updated),
                      );
                      return updated;
                    });
                  }}
                  className="mt-0.5 h-4 w-4 accent-green-500 shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-foreground leading-snug">{item.label}</span>
                  {verifyAutoTicked.has(item.id) && verifyChecks[item.id] && (
                    <p className="text-[10px] text-green-600/80 mt-0.5">
                      ✅ Auto-verified by app
                    </p>
                  )}
                </div>
              </label>
            ))}

            <button
              type="button"
              onClick={() => void confirmVerify()}
              disabled={
                !allChecked ||
                verifying ===
                  (verifySheet.category?.category_id
                    ? `${verifySheet.vendor.id}:${verifySheet.category.category_id}`
                    : verifySheet.vendor.id)
              }
              className={`w-full rounded-2xl py-4 font-bold text-sm transition-colors mt-4 ${
                allChecked ? "bg-green-500 text-white" : "bg-muted text-muted-foreground cursor-not-allowed"
              }`}
            >
              {verifying ===
              (verifySheet.category?.category_id
                ? `${verifySheet.vendor.id}:${verifySheet.category.category_id}`
                : verifySheet.vendor.id)
                ? s.settings_verifying
                : allChecked
                  ? s.settings_markVerified_ready
                  : s.settings_checks_required}
            </button>

            <button
              type="button"
              onClick={closeVerifySheet}
              className="w-full text-xs text-muted-foreground underline mt-3 py-2"
            >
              {s.settings_cancel}
            </button>
          </div>
        </div>
      )}
      </div>

      <PhoneEntrySheet
        isOpen={phoneEntryOpen}
        onClose={() => setPhoneEntryOpen(false)}
        context="settings"
        skipRecovery
        onConfirmed={(phone) => {
          void (async () => {
            await migrateUserPhone(phone, getDeviceId());
            void ensureUserDeviceLink(phone);
            setPhoneEntryOpen(false);
            setIdentityNonce((n) => n + 1);
            toast.success(s.settings_phoneSaved);
          })();
        }}
      />
    </AppShell>
  );
};

export default Settings;
