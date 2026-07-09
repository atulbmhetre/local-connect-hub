import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAppConfig } from "@/hooks/useAppConfig";
import { useNavigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  getReferralCode,
  isReferralEnabled,
  referralCodeFromPhone,
} from "@/lib/referral";
import {
  supabase,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
  type VerificationStatus,
  type Category,
  SHOP_PHOTOS_BUCKET,
  VENDOR_SELFIES_BUCKET,
  GPS_MATCH_TOLERANCE_M,
  isValidPhone,
  isValidUpi,
  isMobileCategory,
  distanceMeters,
  useCategoryLabel,
  useServiceModeLabel,
  invokeNotifyUser,
  invokeNotifyAdmin,
  invokeRegisterVendor,
  invokeAttachPendingCategory,
  invokeSuggestCategory,
  type CategorySuggestionResult,
} from "@/lib/supabase";
import { patchVendorOwn } from "@/lib/vendorPatch";
import { formatVendorDeletionDate } from "@/lib/vendorDeletion";
import {
  isNetworkFailure,
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import { toast } from "sonner";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  Power,
  AlertCircle,
  MapPin,
  Camera,
  ShieldCheck,
  AlertTriangle,
  Truck,
  ChevronRight,
  ChevronDown,
  BarChart2,
  Pencil,
  X,
} from "lucide-react";
import { LiveCamera, type CapturedShot } from "@/components/LiveCamera";
import { VerificationBadge } from "@/components/VerificationBadge";
import { IncomingOrdersSection } from "@/components/IncomingOrdersSection";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import {
  VendorAnalytics,
  type VendorOrderStats,
} from "@/components/vendor/VendorAnalytics";
import { cn } from "@/lib/utils";
import { notifyVendorIdChanged } from "@/lib/vendorSessionSync";
import { useLanguage } from '@/lib/language';
import { registerPushToken } from "../lib/pushNotifications";
import { checkAndNotifyAdminGreenReady } from "@/lib/vendorGreenReady";
import { NotificationBell } from "@/components/NotificationBell";
import { Textarea } from "@/components/ui/textarea";

import { Capacitor } from "@capacitor/core";
import {
  VendorOnboarding,
  isVendorOnboardingComplete,
} from "@/components/VendorOnboarding";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

const STORAGE_KEY = "aaspaas:vendor_id";
const REGISTERED_BANNER_DISMISS_PREFIX = "aaspaas:vendor_registered_banner_dismissed_";

function registeredBannerDismissKey(vendorId: string): string {
  return `${REGISTERED_BANNER_DISMISS_PREFIX}${vendorId}`;
}

function isRegisteredBannerDismissed(vendorId: string): boolean {
  try {
    return localStorage.getItem(registeredBannerDismissKey(vendorId)) === "true";
  } catch {
    return false;
  }
}

function dismissRegisteredBanner(vendorId: string): void {
  try {
    localStorage.setItem(registeredBannerDismissKey(vendorId), "true");
  } catch {
    /* ignore */
  }
}

function isDuplicateVendorPhoneError(error: { code?: string; message?: string }): boolean {
  if (error.code === "23505") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    (msg.includes("duplicate") || msg.includes("unique")) &&
    (msg.includes("phone") || msg.includes("vendors"))
  );
}

function isRateLimitedError(error: { code?: string; message?: string }): boolean {
  return (error.message ?? "").toLowerCase().includes("rate_limited");
}

import { VendorRegistrationWizard } from "@/components/vendor/VendorRegistrationWizard";
import {
  type AvailabilityMode,
  type BaseTypeValue,
  type ReachChoiceValue,
  baseTypeToVendorType,
  looksLikeGibberish,
  reachChoiceFromFlags,
  reachFlagsFromChoice,
  vendorTypeToBaseType,
  MAX_REG_CATEGORIES,
  resolveRegistrationShopName,
} from "@/lib/vendorRegistration";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
import { parseUpiPayeeIdFromQrPayload, decodeUpiPayeeIdFromImageFile } from "@/lib/upiQrDecode";

export { parseUpiPayeeIdFromQrPayload } from "@/lib/upiQrDecode";

type ServiceModeValue = "" | "help" | "delivery" | "appointment" | "booking";
type VendorTypeValue = "" | "shop" | "home" | "visiting";

type RegCategoryRow = Pick<Category, "id" | "label" | "emoji"> & {
  service_mode: string;
};

function categoryServiceModeChipLabel(
  mode: string,
  s: {
    category_chip_mode_help: string;
    category_chip_mode_delivery: string;
    category_chip_mode_booking: string;
    category_chip_mode_appointment: string;
  },
): string {
  switch (mode) {
    case "help":
      return s.category_chip_mode_help;
    case "delivery":
      return s.category_chip_mode_delivery;
    case "booking":
      return s.category_chip_mode_booking;
    case "appointment":
      return s.category_chip_mode_appointment;
    default:
      return mode;
  }
}

function isAppointmentToday(iso: string): boolean {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function orderBlocksGoingOffline(
  order: { delivery_slot: string | null; appointment_time: string | null },
  serviceMode: string | null | undefined,
): boolean {
  const mode = serviceMode ?? "help";
  if (mode === "help") return true;
  if (mode === "delivery") {
    return (order.delivery_slot ?? "").trim().toLowerCase() !== "tomorrow";
  }
  if (mode === "appointment") {
    return order.appointment_time != null && isAppointmentToday(order.appointment_time);
  }
  return false;
}

type BlockingOfflineOrder = {
  id: string;
  status: string;
  appointment_status: string | null;
  user_phone: string | null;
  delivery_slot: string | null;
  appointment_time: string | null;
};

function orderShouldNotifyVendorOffline(order: BlockingOfflineOrder): boolean {
  if (order.status === "accepted") return true;
  return order.appointment_status === "confirmed";
}

function orderShouldNotifyPendingVendorOffline(
  order: BlockingOfflineOrder,
  serviceMode: string | null | undefined,
): boolean {
  if (order.status !== "sent" && order.status !== "seen") return false;
  if (orderShouldNotifyVendorOffline(order)) return false;
  const mode = serviceMode ?? "help";
  if (mode === "help") return false;
  return orderBlocksGoingOffline(order, mode);
}

async function fetchBlockingActiveOrders(
  vendorId: string,
  serviceMode: string | null | undefined,
): Promise<BlockingOfflineOrder[]> {
  const { data, error } = await supabase
    .from("requests")
    .select("id, status, appointment_status, user_phone, delivery_slot, appointment_time")
    .eq("vendor_id", vendorId)
    .in("status", ["sent", "seen", "accepted"]);
  if (error || !data?.length) return [];
  return (data as BlockingOfflineOrder[]).filter((row) =>
    orderBlocksGoingOffline(row, serviceMode),
  );
}

// Heuristic gibberish — see vendorRegistration.ts

const VendorPostRegistrationGuidance = ({ vendor }: { vendor: Vendor }) => {
  const { s } = useLanguage();
  const hasPhoto =
    vendor.shop_photo_url != null && String(vendor.shop_photo_url).trim() !== "";

  if (vendor.is_manual_verified) {
    return (
      <div className="rounded-2xl border border-brand/45 bg-brand-muted p-4 text-sm">
        <p className="font-semibold text-brand">🟢 {s.vendor_verified_title}</p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_verified_body}
        </p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_verified_cta}
        </p>
      </div>
    );
  }

  if (hasPhoto && !vendor.is_manual_verified) {
    return (
      <div className="rounded-2xl border border-amber-500/45 bg-amber-500/10 p-4 text-sm">
        <p className="font-semibold text-amber-100">📋 {s.vendor_submitted_title}</p>
        <p className="mt-2 text-muted-foreground leading-relaxed">
          {s.vendor_submitted_body}
        </p>
      </div>
    );
  }

  return null;
};

function vendorPhotoCopy(
  vendorType: VendorTypeValue | Vendor["vendor_type"] | null | undefined,
  s: {
    vendor_photo_title_shop: string;
    vendor_photo_title_home: string;
    vendor_photo_title_visiting: string;
    vendor_photo_hint_shop: string;
    vendor_photo_hint_home: string;
    vendor_photo_hint_visiting: string;
  },
) {
  if (vendorType === "home") {
    return { title: s.vendor_photo_title_home, hint: s.vendor_photo_hint_home };
  }
  if (vendorType === "visiting") {
    return { title: s.vendor_photo_title_visiting, hint: s.vendor_photo_hint_visiting };
  }
  return { title: s.vendor_photo_title_shop, hint: s.vendor_photo_hint_shop };
}

const VendorMode = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const highlightVendorId = (location.state as { highlightVendorId?: string } | null)
    ?.highlightVendorId;
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();
  const [vendorId, setVendorId] = useState<string | null>(
    localStorage.getItem(STORAGE_KEY),
  );
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [vendor, setVendor] = useState<Vendor | null>(null);
  const trialDaysLeft =
    vendor != null
      ? vendor.trial_ends_at
        ? Math.max(
            0,
            Math.floor(
              (new Date(vendor.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
            ),
          )
        : 0
      : null;
  const isInTrial =
    trialDaysLeft !== null && trialDaysLeft > 0 && !vendor?.subscription_active;
  const [loading, setLoading] = useState(false);
  const [vendorOrderStats, setVendorOrderStats] = useState<VendorOrderStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [networkLoadStatus, setNetworkLoadStatus] = useState<"retrying" | "failed" | null>(null);
  const [vendorFetchTick, setVendorFetchTick] = useState(0);

  // ---- registration form ----
  const [vendorType, setVendorType] = useState<VendorTypeValue>("");
  const [name, setName] = useState("");
  const [shopName, setShopName] = useState("");
  const [regCategories, setRegCategories] = useState<RegCategoryRow[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [regCategoriesLoading, setRegCategoriesLoading] = useState(false);
  const [businessDescription, setBusinessDescription] = useState("");
  const [categorySuggesting, setCategorySuggesting] = useState(false);
  const [categorySuggestion, setCategorySuggestion] =
    useState<CategorySuggestionResult | null>(null);
  const [showManualCategories, setShowManualCategories] = useState(false);
  const [extraRegCategories, setExtraRegCategories] = useState<RegCategoryRow[]>([]);
  const [pendingNewCategoryCreate, setPendingNewCategoryCreate] = useState<{
    description: string;
    category_name: string;
    service_mode: string;
  } | null>(null);
  /** help | delivery | appointment — empty until selected or inferred from category. */
  const [serviceMode, setServiceMode] = useState<ServiceModeValue>("");
  const [vendorNote, setVendorNote] = useState("");
  const [referralCodeInput, setReferralCodeInput] = useState("");
  const [referralEnabled, setReferralEnabled] = useState(false);
  const [upi, setUpi] = useState("");
  const [upiBlurred, setUpiBlurred] = useState(false);
  const [upiQrUrl, setUpiQrUrl] = useState("");
  const [upiQrPayeeId, setUpiQrPayeeId] = useState<string | null>(null);
  const [upiQrUploading, setUpiQrUploading] = useState(false);
  const upiQrInputRef = useRef<HTMLInputElement>(null);
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationInlineError, setLocationInlineError] = useState<string | null>(null);
  const [showLocationHelp, setShowLocationHelp] = useState(false);

  // ---- profile actions ----
  const [cameraOpen, setCameraOpen] = useState(false);
  const [selfieCameraOpen, setSelfieCameraOpen] = useState(false);
  const [verifyingUpi, setVerifyingUpi] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);
  const [verificationSheetOpen, setVerificationSheetOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [alreadyRegistered, setAlreadyRegistered] = useState(false);
  const [lookupPhone, setLookupPhone] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const pushRegisteredVendorRef = useRef<string | null>(null);
  const alreadyRegisteredRef = useRef<HTMLDivElement>(null);
  const isTogglingRef = useRef(false);
  const vendorFetchInFlightRef = useRef(false);
  const [highlightAlreadyRegistered, setHighlightAlreadyRegistered] = useState(false);
  const [goLivePromptVisible, setGoLivePromptVisible] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [offlineConfirmOpen, setOfflineConfirmOpen] = useState(false);
  const [checkingOffline, setCheckingOffline] = useState(false);
  const [offlineBlockingOrders, setOfflineBlockingOrders] = useState<BlockingOfflineOrder[]>([]);

  const [editShopOpen, setEditShopOpen] = useState(false);
  const [editVendorType, setEditVendorType] = useState<VendorTypeValue>("");
  const [editShopName, setEditShopName] = useState("");
  const [editAvailableCategories, setEditAvailableCategories] = useState<RegCategoryRow[]>([]);
  const [editSelectedCategories, setEditSelectedCategories] = useState<RegCategoryRow[]>([]);
  const [editSelectedCategoryIds, setEditSelectedCategoryIds] = useState<string[]>([]);
  const [editCategoriesLoading, setEditCategoriesLoading] = useState(false);
  const [editPhone, setEditPhone] = useState("");
  const [editUpiId, setEditUpiId] = useState("");
  const [editBaseType, setEditBaseType] = useState<BaseTypeValue>("");
  const [editReachChoice, setEditReachChoice] = useState<ReachChoiceValue>("");
  const [editAvailabilityModes, setEditAvailabilityModes] = useState<AvailabilityMode[]>([]);
  const [editServiceRadiusKm, setEditServiceRadiusKm] = useState<number | null>(null);
  const [savingShopDetails, setSavingShopDetails] = useState(false);
  const editCategoriesLoadSeqRef = useRef(0);
  const editSelectedCategoryIdsRef = useRef<string[]>([]);

  useEffect(() => {
    localStorage.setItem("aaspaas:role", "vendor");
  }, []);

  useEffect(() => {
    void isReferralEnabled().then(setReferralEnabled);
    const stored = getReferralCode();
    if (stored) setReferralCodeInput(stored);
  }, []);

  // Broadcast vendor "live" state so the BottomNav can pulse the Vendor tab.
  useEffect(() => {
    const live = !!vendor?.is_active;
    if (live) localStorage.setItem("aaspaas:vendor_active", "1");
    else localStorage.removeItem("aaspaas:vendor_active");
    window.dispatchEvent(new CustomEvent("aaspaas:vendor_active_changed", { detail: live }));
    return () => {
      // On unmount we don't clear — the flag should reflect DB state, not route.
    };
  }, [vendor?.is_active]);

  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;

    const fetchVendor = async () => {
      if (isTogglingRef.current || vendorFetchInFlightRef.current) return;
      vendorFetchInFlightRef.current = true;
      setLoading(true);
      setNetworkLoadStatus(null);
      try {
        const { data, error: fetchError } = await withNetworkRetry(
          async () =>
            throwOnSupabaseNetworkError(
              await supabase
                .from("vendors")
                .select("*")
                .eq("id", vendorId)
                .maybeSingle()
                .retry(false),
            ),
          {
            onRetrying: () => {
              if (!cancelled) setNetworkLoadStatus("retrying");
            },
            shouldRetry: () => getNavigatorOnline(),
          },
        );
        if (cancelled || isTogglingRef.current) return;
        if (fetchError) {
          setError(s.vendor_load_registered_failed);
          setNetworkLoadStatus(null);
        } else if (!data) {
          localStorage.removeItem(STORAGE_KEY);
          setVendorId(null);
          setNetworkLoadStatus(null);
        } else {
          setVendor(data as Vendor);
          setNetworkLoadStatus(null);
          setError(null);
        }
      } catch (err) {
        if (cancelled || isTogglingRef.current) return;
        if (err instanceof NetworkExhaustedError) {
          setNetworkLoadStatus("failed");
          setError(null);
        } else {
          throw err;
        }
      } finally {
        vendorFetchInFlightRef.current = false;
        if (!cancelled && !isTogglingRef.current) setLoading(false);
      }
    };

    if (!isTogglingRef.current) {
      void fetchVendor();
    }

    const channel = supabase
      .channel(`vendor-${vendorId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "vendors", filter: `id=eq.${vendorId}` },
        (payload) => {
          if (isTogglingRef.current) return;
          setVendor(payload.new as Vendor);
        },
      )
      .subscribe();

    const pingInterval = window.setInterval(() => {
      void (async () => {
        if (!vendor?.is_active || !vendor?.phone) return;
        const { error } = await patchVendorOwn(vendorId, vendor.phone, {
          last_updated: new Date().toISOString(),
        });
        if (error) console.error("Vendor ping failed:", error.message);
      })();
    }, 20 * 60 * 1000);

    return () => {
      cancelled = true;
      vendorFetchInFlightRef.current = false;
      supabase.removeChannel(channel);
      window.clearInterval(pingInterval);
    };
  }, [vendorId, vendorFetchTick]);

  useEffect(() => {
    if (!vendor?.id) return;
    let cancelled = false;

    void (async () => {
      const { data } = await supabase
        .from("requests")
        .select("status, appointment_status, created_at")
        .eq("vendor_id", vendor.id);

      if (cancelled) return;

      const orders = data ?? [];
      console.log("vendorOrderStats", vendor.id, orders.length);

      const now = new Date();
      setVendorOrderStats({
        total: orders.length,
        thisMonth: orders.filter((o) => {
          const d = new Date(o.created_at);
          return (
            d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
          );
        }).length,
        fulfilled: orders.filter(
          (o) => o.status === "fulfilled" || o.status === "done",
        ).length,
        declined: orders.filter((o) => o.appointment_status === "declined").length,
        cancelled: orders.filter((o) => o.status === "cancelled").length,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [vendor?.id]);

  useEffect(() => {
    if (!vendorId || vendor?.id !== vendorId) return;
    if (pushRegisteredVendorRef.current === vendorId) return;
    pushRegisteredVendorRef.current = vendorId;
    void registerPushToken(vendorId);
  }, [vendorId, vendor?.id]);

  useEffect(() => {
    if (!highlightVendorId || !vendor?.id || highlightVendorId !== vendor.id) return;
    const el =
      document.getElementById("vendor-verification-banner") ??
      document.getElementById("vendor-incoming-orders");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlightVendorId, vendor?.id, loading]);

  useEffect(() => {
    if (
      Capacitor.isNativePlatform() &&
      vendorId &&
      vendor &&
      !isVendorOnboardingComplete()
    ) {
      setShowOnboarding(true);
    }
  }, [vendorId, vendor]);

  useEffect(() => {
    if (!vendor?.id || vendor.is_banned) {
      setGoLivePromptVisible(false);
      return;
    }
    setGoLivePromptVisible(!isRegisteredBannerDismissed(vendor.id));
  }, [vendor?.id, vendor?.is_banned]);

  const detectLocation = (opts?: { silent?: boolean }): Promise<{ lat: number; lng: number } | null> => {
    return new Promise((resolve) => {
      if (!("geolocation" in navigator)) {
        if (!opts?.silent) toast.error(s.vendor_geo_not_supported);
        setLocationInlineError(s.vendor_geo_not_supported);
        resolve(null);
        return;
      }
      setLocating(true);
      setLocationInlineError(null);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude };
          setCoords(c);
          setLocating(false);
          setLocationInlineError(null);
          setShowLocationHelp(false);
          if (!opts?.silent) toast.success(s.vendor_location_captured);
          resolve(c);
        },
        (err) => {
          setLocating(false);
          const code = (err as GeolocationPositionError | undefined)?.code;
          let msg: string = s.vendor_location_failed;
          if (code === 1) msg = s.vendor_location_error_permission_denied;
          if (code === 2) msg = s.vendor_location_error_unavailable;
          if (code === 3) msg = s.vendor_location_error_timeout;
          setLocationInlineError(msg);
          setShowLocationHelp(true);
          if (!opts?.silent) toast.error(msg);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });
  };

  useEffect(() => {
    if (vendorId) return;
    let cancelled = false;
    setRegCategoriesLoading(true);
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("load registration categories", error);
          setRegCategories([]);
        } else {
          setRegCategories((data ?? []) as RegCategoryRow[]);
        }
        setRegCategoriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  useEffect(() => {
    if (!vendor?.id || vendor.vendor_type !== "visiting") return;
    if (vendor.latitude != null && vendor.longitude != null) return;

    let cancelled = false;
    void (async () => {
      if (!("geolocation" in navigator)) return;
      const c = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
        );
      });
      if (cancelled || !c || !vendor.phone) return;
      const { error } = await patchVendorOwn(vendor.id, vendor.phone, {
        latitude: c.lat,
        longitude: c.lng,
      });
      if (error || cancelled) return;
      setVendor((prev) => (prev ? { ...prev, latitude: c.lat, longitude: c.lng } : prev));
    })();

    return () => {
      cancelled = true;
    };
  }, [vendor?.id, vendor?.vendor_type, vendor?.latitude, vendor?.longitude]);

  // ---- registration ----
  const phoneOk = isValidPhone(phone);
  const upiFmtOk = isValidUpi(upi);
  const upiFormatError =
    upiBlurred && upi.trim().length > 0 && !upiFmtOk ? s.vendor_upi_id_format_invalid : undefined;

  const allRegCategories = useMemo(() => {
    const map = new Map<string, RegCategoryRow>();
    for (const c of [...regCategories, ...extraRegCategories]) {
      map.set(c.id, c);
    }
    return [...map.values()];
  }, [regCategories, extraRegCategories]);

  const primaryCategory =
    selectedCategoryIds.length > 0
      ? allRegCategories.find((c) => c.id === selectedCategoryIds[0]) ?? null
      : null;
  const effectiveCategory =
    primaryCategory?.label ?? pendingNewCategoryCreate?.category_name ?? "";
  const categoryOk =
    (selectedCategoryIds.length > 0 && effectiveCategory.length > 1) ||
    pendingNewCategoryCreate != null;
  const nameOk = name.trim().length > 1 && !looksLikeGibberish(name);
  const shopOk = shopName.trim().length > 1 && !looksLikeGibberish(shopName);
  const homeShopInvalid =
    vendorType === "home" &&
    shopName.trim().length > 0 &&
    (shopName.trim().length <= 1 || looksLikeGibberish(shopName));
  const shopFieldOk =
    vendorType === "shop" ? shopOk : vendorType === "home" ? !homeShopInvalid : true;
  const vendorTypeOk = vendorType !== "";

  useEffect(() => {
    if (selectedCategoryIds.length === 0) {
      setServiceMode("");
      return;
    }
    const first = allRegCategories.find((c) => c.id === selectedCategoryIds[0]);
    if (first) setServiceMode(first.service_mode as ServiceModeValue);
  }, [selectedCategoryIds, allRegCategories]);

  const selectCategoryFromSuggestion = (
    id: string,
    label: string,
    emoji: string | null | undefined,
    serviceModeValue: string,
  ) => {
    setExtraRegCategories((prev) => {
      if (prev.some((c) => c.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          label,
          emoji: emoji ?? "✨",
          service_mode: serviceModeValue,
        },
      ];
    });
    setSelectedCategoryIds([id]);
    setServiceMode(serviceModeValue as ServiceModeValue);
    setCategorySuggestion(null);
    setPendingNewCategoryCreate(null);
    setShowManualCategories(false);
  };

  const handleFindCategory = async () => {
    const desc = businessDescription.trim();
    if (desc.length < 3) {
      toast.error(s.vendor_specify_hint);
      return;
    }
    setCategorySuggesting(true);
    setCategorySuggestion(null);
    setPendingNewCategoryCreate(null);
    try {
      const result = await withNetworkRetry(
        async () => {
          const r = await invokeSuggestCategory({ description: desc });
          if (!r.success && r.error && isNetworkFailure({ message: r.error })) {
            throw new Error(r.error);
          }
          return r;
        },
        {
          onRetrying: () => showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      setCategorySuggesting(false);
      if (!result.success) {
        const regCategoriesAlreadyVisible =
          showManualCategories && !regCategoriesLoading && allRegCategories.length > 0;
        setShowManualCategories(true);
        if (!regCategoriesAlreadyVisible) {
          toast.error(result.error ?? s.vendor_understanding);
        }
        return;
      }
      setCategorySuggestion(result);
      if (result.outcome === "low_confidence") {
        setShowManualCategories(true);
      }
    } catch (err) {
      dismissNetworkRetryingToast();
      setCategorySuggesting(false);
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleFindCategory(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const confirmNewCategorySuggestion = () => {
    if (!categorySuggestion?.category_name || !businessDescription.trim()) return;
    setPendingNewCategoryCreate({
      description: businessDescription.trim(),
      category_name: categorySuggestion.category_name,
      service_mode: categorySuggestion.service_mode ?? "help",
    });
    setCategorySuggestion(null);
    toast.success(s.category_suggest_new(categorySuggestion.category_name));
  };

  const toggleRegCategory = (categoryId: string) => {
    setSelectedCategoryIds((prev) => {
      if (prev.includes(categoryId)) {
        return prev.filter((id) => id !== categoryId);
      }
      if (prev.length >= MAX_REG_CATEGORIES) return prev;
      return [...prev, categoryId];
    });
  };

  useEffect(() => {
    if (vendorId || vendorType !== "visiting") return;
    void detectLocation({ silent: true });
  }, [vendorId, vendorType]);

  const canRegister =
    vendorTypeOk &&
    nameOk &&
    shopFieldOk &&
    categoryOk &&
    serviceMode !== "" &&
    phoneOk &&
    upiFmtOk &&
    !loading;

  const handleUpiQrFile = async (file: File) => {
    setUpiQrUploading(true);
    setUpiQrPayeeId(null);
    const path = `upi-qr/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage.from("vendor-docs").upload(path, file, {
      contentType: file.type || "image/jpeg",
      upsert: true,
    });
    if (upErr) {
      toast.error("QR upload failed");
      setUpiQrUploading(false);
      return;
    }
    const { data: pub } = supabase.storage.from("vendor-docs").getPublicUrl(path);
    setUpiQrUrl(pub.publicUrl);
    const payeeId = await decodeUpiPayeeIdFromImageFile(file);
    setUpiQrPayeeId(payeeId);
    setUpiQrUploading(false);
  };

  const toggleEditCategory = (categoryId: string) => {
    setEditSelectedCategoryIds((prev) => {
      const next = prev.includes(categoryId)
        ? prev.filter((id) => id !== categoryId)
        : prev.length >= MAX_REG_CATEGORIES
          ? prev
          : [...prev, categoryId];
      editSelectedCategoryIdsRef.current = next;
      setEditSelectedCategories((prevSelected) =>
        next
          .map(
            (id) =>
              editAvailableCategories.find((c) => c.id === id) ??
              prevSelected.find((c) => c.id === id),
          )
          .filter((c): c is RegCategoryRow => c != null),
      );
      return next;
    });
  };

  const openEditShop = () => {
    if (!vendor) return;
    const loadSeq = ++editCategoriesLoadSeqRef.current;
    setEditShopName(vendor.shop_name ?? "");
    setEditPhone(vendor.phone ?? "");
    setEditUpiId(vendor.upi_id ?? "");
    setEditBaseType(
      vendor.base_type
        ? (vendor.base_type as BaseTypeValue)
        : vendorTypeToBaseType(vendor.vendor_type),
    );
    setEditReachChoice(
      reachChoiceFromFlags(vendor.serves_at_vendor_place, vendor.serves_at_customer_place),
    );
    setEditServiceRadiusKm(vendor.service_radius_km ?? null);
    setEditAvailabilityModes([]);
    const vt = vendor.vendor_type;
    setEditVendorType(
      vt === "shop" || vt === "home" || vt === "visiting" ? vt : "shop",
    );
    setEditAvailableCategories([]);
    setEditSelectedCategories([]);
    editSelectedCategoryIdsRef.current = [];
    setEditSelectedCategoryIds([]);
    setEditCategoriesLoading(true);
    setEditShopOpen(true);

    void (async () => {
      const [availResult, vcResult, modesResult] = await Promise.all([
        supabase
          .from("categories")
          .select("id, label, emoji, service_mode")
          .eq("is_active", true)
          .order("sort_order", { ascending: true }),
        supabase
          .from("vendor_categories")
          .select("category_id, is_primary, categories(id, label, emoji, service_mode)")
          .eq("vendor_id", vendor.id)
          .eq("status", "approved")
          .order("is_primary", { ascending: false }),
        supabase
          .from("vendor_availability_modes")
          .select("mode")
          .eq("vendor_id", vendor.id),
      ]);

      if (availResult.error) {
        console.error("load edit categories", availResult.error);
      }
      const available = (availResult.data ?? []) as RegCategoryRow[];
      setEditAvailableCategories(available);

      let selected: RegCategoryRow[] = [];
      if (!vcResult.error && vcResult.data?.length) {
        for (const row of vcResult.data) {
          const joined = row.categories;
          const cat = Array.isArray(joined) ? joined[0] : joined;
          if (!cat) continue;
          selected.push({
            id: cat.id,
            label: cat.label,
            emoji: cat.emoji,
            service_mode: cat.service_mode,
          });
        }
      }

      if (selected.length === 0 && vendor.category) {
        const legacy = available.find((c) => c.label === vendor.category);
        if (legacy) selected = [legacy];
      }

      if (loadSeq !== editCategoriesLoadSeqRef.current) return;

      const selectedIds = selected.map((c) => c.id);
      editSelectedCategoryIdsRef.current = selectedIds;
      setEditSelectedCategories(selected);
      setEditSelectedCategoryIds(selectedIds);
      const modes = (modesResult.data ?? [])
        .map((row) => row.mode as AvailabilityMode)
        .filter((m) => m === "help" || m === "delivery" || m === "appointment");
      setEditAvailabilityModes(
        modes.length > 0 ? modes : [(vendor.service_mode ?? "help") as AvailabilityMode],
      );
      setEditCategoriesLoading(false);
    })();
  };

  const saveShopDetails = async () => {
    if (!vendor) return;
    const categoryIdsToSave = editSelectedCategoryIdsRef.current;
    const primaryCategory =
      editAvailableCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      editSelectedCategories.find((c) => c.id === categoryIdsToSave[0]) ??
      null;
    const primaryLabel = primaryCategory?.label ?? "";
    const primaryServiceMode = (editAvailabilityModes[0] ??
      primaryCategory?.service_mode ??
      vendor.service_mode ??
      "") as ServiceModeValue;
    const resolvedShopName = resolveRegistrationShopName(
      editBaseType,
      vendor.name,
      editShopName,
    );
    const reachFlags = editReachChoice ? reachFlagsFromChoice(editReachChoice) : null;
    const mappedVendorType = baseTypeToVendorType(editBaseType);

    if (
      editBaseType === "" ||
      !mappedVendorType ||
      !resolvedShopName.trim() ||
      categoryIdsToSave.length === 0 ||
      !primaryLabel ||
      !primaryServiceMode ||
      !editPhone.trim() ||
      !reachFlags ||
      editAvailabilityModes.length === 0
    ) {
      return;
    }
    setSavingShopDetails(true);

    const radiusKm =
      reachFlags.serves_at_customer_place && editServiceRadiusKm != null
        ? editServiceRadiusKm
        : vendor.service_radius_km;

    const { error } = await patchVendorOwn(vendor.id, editPhone.trim(), {
      shop_name: resolvedShopName.trim(),
      category: primaryLabel,
      service_mode: primaryServiceMode,
      vendor_type: mappedVendorType,
      base_type: editBaseType,
      serves_at_vendor_place: reachFlags.serves_at_vendor_place,
      serves_at_customer_place: reachFlags.serves_at_customer_place,
      service_radius_km: radiusKm,
      phone: editPhone.trim(),
      upi_id: editUpiId.trim() || null,
      is_manual_verified: false,
      verification_status: "identity_linked",
      shop_photo_url: null,
      upi_verified: false,
    });

    if (error) {
      setSavingShopDetails(false);
      toast.error(s.vendor_update_failed);
      return;
    }

    const categoryServiceModes = categoryIdsToSave.map((categoryId) => {
      const cat =
        editAvailableCategories.find((c) => c.id === categoryId) ??
        editSelectedCategories.find((c) => c.id === categoryId);
      return cat?.service_mode ?? primaryServiceMode;
    });

    const { error: vcError } = await supabase.rpc("vendor_update_categories", {
      p_vendor_id: vendor.id,
      p_vendor_phone: editPhone.trim(),
      p_category_ids: categoryIdsToSave,
      p_category_service_modes: categoryServiceModes,
    });
    if (vcError) {
      setSavingShopDetails(false);
      console.error("vendor_update_categories", vcError);
      toast.error(s.vendor_categories_partial_save);
      return;
    }

    const { error: modesError } = await supabase.rpc("vendor_update_availability_modes", {
      p_vendor_id: vendor.id,
      p_vendor_phone: editPhone.trim(),
      p_modes: editAvailabilityModes,
    });
    setSavingShopDetails(false);
    if (modesError) {
      console.error("vendor_update_availability_modes", modesError);
      toast.error(s.vendor_update_failed);
      return;
    }

    const { error: syncError } = await supabase.rpc("vendor_sync_category_modes", {
      p_vendor_id: vendor.id,
      p_vendor_phone: editPhone.trim(),
      p_modes: editAvailabilityModes,
    });
    setSavingShopDetails(false);
    if (syncError) {
      console.error("vendor_sync_category_modes", syncError);
      toast.error(s.vendor_update_failed);
      return;
    }

    setVendor((prev) =>
      prev
        ? {
            ...prev,
            shop_name: resolvedShopName.trim(),
            category: primaryLabel,
            service_mode: primaryServiceMode,
            vendor_type: mappedVendorType,
            base_type: editBaseType,
            serves_at_vendor_place: reachFlags.serves_at_vendor_place,
            serves_at_customer_place: reachFlags.serves_at_customer_place,
            service_radius_km: radiusKm,
            phone: editPhone.trim(),
            upi_id: editUpiId.trim() || null,
            is_manual_verified: false,
            verification_status: "identity_linked",
            shop_photo_url: null,
            upi_verified: false,
          }
        : prev,
    );
    void invokeNotifyAdmin(
      "✏️ Vendor edited shop details",
      `${resolvedShopName.trim()} — ${primaryLabel} (${primaryServiceMode})`,
      {
        type: "vendor_edited",
        route: "vendor",
        route_params: { vendor_id: vendor.id },
      },
    );
    setEditShopOpen(false);
    toast.success("Shop details updated. Admin will re-verify your account.");
  };

  const editShopNameInvalid =
    editShopName.trim().length > 0 &&
    (editShopName.trim().length <= 1 || looksLikeGibberish(editShopName));
  const editShopFieldOk =
    editBaseType === "shop"
      ? editShopName.trim().length > 1 && !looksLikeGibberish(editShopName)
      : editBaseType === "home"
        ? !editShopNameInvalid
        : editBaseType === "none";
  const editNeedsRadius =
    editReachChoice === "customer" || editReachChoice === "both";
  const editRadiusOk = !editNeedsRadius || editServiceRadiusKm != null;

  const editShopSaveReady =
    editBaseType !== "" &&
    editShopFieldOk &&
    editSelectedCategoryIds.length > 0 &&
    editPhone.trim().length > 0 &&
    editReachChoice !== "" &&
    editRadiusOk &&
    editAvailabilityModes.length > 0;

  const handleWizardRegistered = async (newVendorId: string) => {
    const { data: vendorRow, error: vendorFetchError } = await supabase
      .from("vendors")
      .select("*")
      .eq("id", newVendorId)
      .single();
    if (vendorFetchError || !vendorRow) {
      setError(vendorFetchError?.message ?? "Could not load registered vendor");
      return;
    }
    localStorage.setItem(STORAGE_KEY, newVendorId);
    notifyVendorIdChanged();
    setVendorId(newVendorId);
    setVendor(vendorRow as Vendor);
  };

  const handleDuplicateRegistrationPhone = () => {
    toast.error(s.vendor_duplicate_phone);
    setError(null);
    setHighlightAlreadyRegistered(true);
    window.setTimeout(() => {
      alreadyRegisteredRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    window.setTimeout(() => setHighlightAlreadyRegistered(false), 2500);
  };

  const lookupVendorByPhone = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = lookupPhone.replace(/\D/g, "");
    const digits =
      cleaned.length === 12 && cleaned.startsWith("91")
        ? cleaned.slice(2)
        : cleaned.length === 11 && cleaned.startsWith("1")
          ? cleaned.slice(1)
          : cleaned;
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
      setLookupError(s.vendor_phone_invalid_body);
      return;
    }
    setLookupError(null);
    setLookupLoading(true);
    try {
      const variants = [digits, `+91${digits}`, `91${digits}`, `+91 ${digits}`];
      let found: Vendor | null = null;
      for (const v of variants) {
        const { data, error } = await supabase
          .from("vendors")
          .select("*")
          .eq("phone", v)
          .eq("is_banned", false)
          .is("deletion_requested_at", null)
          .maybeSingle();
        if (error) continue;
        if (data) {
          found = data as Vendor;
          break;
        }
      }
      if (found) {
        if (found.phone.startsWith("deleted_")) {
          toast.error(s.vendor_phone_register_blocked);
          return;
        }
        localStorage.setItem(STORAGE_KEY, found.id);
        notifyVendorIdChanged();
        setVendorId(found.id);
        setVendor(found);
        setLookupPhone("");
        setAlreadyRegistered(false);
        setLookupError(null);
        toast.success(s.vendor_welcome_back);
      } else {
        setLookupError(s.vendor_not_found);
      }
    } finally {
      setLookupLoading(false);
    }
  };

  // ---- runtime actions ----
  const applyActiveState = async (next: boolean): Promise<boolean> => {
    if (!vendor) return false;
    if (next && vendor.is_banned) {
      toast.error(s.admin_vendor_banned_title, {
        description: s.admin_vendor_banned_body,
      });
      return false;
    }
    isTogglingRef.current = true;
    setVendor({ ...vendor, is_active: next });

    let liveCoords: { lat: number; lng: number } | null = null;
    if (next && isMobileCategory(vendor.category)) {
      try {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          if (!("geolocation" in navigator)) {
            reject(new Error("Geolocation not supported"));
            return;
          }
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 8000,
            maximumAge: 0,
          });
        });
        liveCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      } catch (err) {
        const code = (err as GeolocationPositionError | undefined)?.code;
        let msg: string = s.vendor_location_required_body;
        if (code === 1) msg = s.vendor_location_error_permission_denied;
        if (code === 2) msg = s.vendor_location_error_unavailable;
        if (code === 3) msg = s.vendor_location_error_timeout;
        setLocationInlineError(msg);
        setShowLocationHelp(true);
        isTogglingRef.current = false;
        setVendor({ ...vendor, is_active: !next });
        toast.error(s.vendor_location_required, {
          description: msg,
        });
        return false;
      }
    }

    const patch: Record<string, unknown> = { is_active: next };
    if (next) {
      patch.last_updated = new Date().toISOString();
    }
    if (liveCoords) {
      patch.latitude = liveCoords.lat;
      patch.longitude = liveCoords.lng;
    }

    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, patch),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        setVendor({ ...vendor, is_active: !next });
        toast.error(s.vendor_status_failed, { description: error.message });
        return false;
      }

      if (next) {
        dismissRegisteredBanner(vendor.id);
        setGoLivePromptVisible(false);
      }

      toast(next ? s.vendor_you_are_live : s.vendor_you_are_offline, {
        description: next
          ? liveCoords
            ? s.vendor_live_body
            : s.vendor_live_body_short
          : s.vendor_offline_body,
      });
      return true;
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        setVendor({ ...vendor, is_active: !next });
        showNetworkFailedToast(() => void applyActiveState(next), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
        return false;
      }
      throw err;
    } finally {
      isTogglingRef.current = false;
    }
  };

  const notifyUsersVendorOffline = (
    orders: BlockingOfflineOrder[],
    serviceMode: string | null | undefined,
  ) => {
    const activeByPhone = new Map<string, string>();
    const pendingByPhone = new Map<string, string>();
    for (const order of orders) {
      const userPhone = order.user_phone?.trim();
      if (!userPhone) continue;
      if (orderShouldNotifyVendorOffline(order)) {
        if (!activeByPhone.has(userPhone)) activeByPhone.set(userPhone, order.id);
        continue;
      }
      if (orderShouldNotifyPendingVendorOffline(order, serviceMode)) {
        if (!pendingByPhone.has(userPhone)) pendingByPhone.set(userPhone, order.id);
      }
    }

    for (const [userPhone, orderId] of activeByPhone) {
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.user_vendor_offline_title,
        body: s.user_vendor_offline_body,
        type: "order_update",
        order_id: orderId,
      });
    }

    for (const [userPhone, orderId] of pendingByPhone) {
      if (activeByPhone.has(userPhone)) continue;
      void invokeNotifyUser({
        user_phone: userPhone,
        title: s.goOffline_pendingOrderNotify_title,
        body: s.goOffline_pendingOrderNotify_body,
        type: "order_update",
        order_id: orderId,
      });
    }
  };

  const toggleActive = async () => {
    if (!vendor || checkingOffline) return;
    const next = !vendor.is_active;

    if (next && vendor.is_banned) {
      toast.error(s.admin_vendor_banned_title, {
        description: s.admin_vendor_banned_body,
      });
      return;
    }

    if (!next) {
      setCheckingOffline(true);
      const blockingOrders = await fetchBlockingActiveOrders(
        vendor.id,
        vendor.service_mode,
      );
      setCheckingOffline(false);
      if (blockingOrders.length > 0) {
        setOfflineBlockingOrders(blockingOrders);
        setOfflineConfirmOpen(true);
        return;
      }
      setOfflineBlockingOrders([]);
    }

    await applyActiveState(next);
  };

  const confirmGoOfflineAnyway = async () => {
    const ordersToNotify = offlineBlockingOrders;
    setOfflineConfirmOpen(false);
    setOfflineBlockingOrders([]);
    const ok = await applyActiveState(false);
    if (ok && ordersToNotify.length > 0) {
      notifyUsersVendorOffline(ordersToNotify, vendor.service_mode);
    }
  };

  const verifyUpi = async () => {
    if (!vendor) return;
    if (!isValidUpi(vendor.upi_id)) {
      toast.error(s.vendor_upi_format_invalid, { description: s.vendor_upi_format_body });
      return;
    }
    setVerifyingUpi(true);
    // Simulated bank-name lookup. Replace with a real PSP call later.
    await new Promise((r) => setTimeout(r, 900));
    const bank = vendor.upi_id.split("@")[1] ?? "bank";
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, { upi_verified: true }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        toast.error(s.vendor_upi_check_failed, { description: error.message });
        return;
      }
      void checkAndNotifyAdminGreenReady(vendor.id);
      setVendor((prev) => (prev ? { ...prev, upi_verified: true } : prev));
      toast.success(`${s.vendor_upi_verified}${bank.toUpperCase()}`, {
        description: s.vendor_upi_bank_valid,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void verifyUpi(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setVerifyingUpi(false);
    }
  };

  const handleShopPhoto = async (shot: CapturedShot) => {
    if (!vendor) return;
    setCameraOpen(false);

    // 1. GPS match check vs the recorded shop coords.
    const hasShopLocation = vendor.latitude != null && vendor.longitude != null;
    let gpsMatchDistance = 0;
    if (hasShopLocation) {
      const meters = distanceMeters(
        { lat: vendor.latitude!, lng: vendor.longitude! },
        shot.coords,
      );
      if (meters > GPS_MATCH_TOLERANCE_M) {
        toast.error(s.vendor_mismatch_title, {
          description: `Photo was taken ${Math.round(meters)} m from your shop. Must be within ${GPS_MATCH_TOLERANCE_M} m.`,
        });
        return;
      }
      gpsMatchDistance = Math.round(meters);
    }

    // 2. Upload to Storage.
    const path = `${vendor.id}/${Date.now()}.jpg`;
    try {
      const { error: upErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.storage.from(SHOP_PHOTOS_BUCKET).upload(path, shot.blob, {
              contentType: "image/jpeg",
              upsert: true,
            }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (upErr) {
        toast.error(s.vendor_upload_failed, { description: upErr.message });
        return;
      }
      const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);

      // 3. Promote to business_verified (admin still gates the green glow).
      const { error: updErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, {
              shop_photo_url: pub.publicUrl,
              verification_status: "business_verified",
              gps_match_distance: gpsMatchDistance,
              ...(hasShopLocation
                ? {}
                : {
                    latitude: shot.coords.lat,
                    longitude: shot.coords.lng,
                  }),
            }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (updErr) {
        toast.error(s.vendor_save_verification_failed, { description: updErr.message });
        return;
      }
      void checkAndNotifyAdminGreenReady(vendor.id);
      if (!hasShopLocation) {
        toast.success("Shop photo saved and location set ✓");
        return;
      }
      toast.success(s.vendor_photo_verified, {
        description: vendor.is_manual_verified
          ? s.vendor_green_badge_live
          : s.vendor_awaiting_admin,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleShopPhoto(shot), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const handleSelfiePhoto = async (shot: CapturedShot) => {
    if (!vendor) return;
    setSelfieCameraOpen(false);

    const path = `${vendor.id}/selfie.jpg`;
    try {
      const { error: upErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.storage.from(VENDOR_SELFIES_BUCKET).upload(path, shot.blob, {
              contentType: "image/jpeg",
              upsert: true,
            }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (upErr) {
        toast.error(s.vendor_upload_failed, { description: upErr.message });
        return;
      }
      const { data: pub } = supabase.storage.from(VENDOR_SELFIES_BUCKET).getPublicUrl(path);

      const { error: updErr } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, {
              photo_selfie: pub.publicUrl,
            }),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (updErr) {
        toast.error(s.vendor_save_verification_failed, { description: updErr.message });
        return;
      }

      const { error: verErr } = await supabase.rpc("submit_vendor_verification", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendor.phone,
        p_check_type: "photo_selfie",
        p_doc_url: pub.publicUrl,
      });
      if (verErr) {
        console.error("photo_selfie verification insert", verErr);
      }

      setVendor((prev) => (prev ? { ...prev, photo_selfie: pub.publicUrl } : prev));
      toast.success(s.vendor_selfie_captured);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleSelfiePhoto(shot), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  };

  const openSelfieCamera = () => {
    if (!vendor?.shop_photo_url) return;
    setSelfieCameraOpen(true);
  };

  const updateShopLocation = async () => {
    if (!vendor) return;
    if (
      vendor.verification_status === "business_verified" ||
      vendor.verification_status === "green_pending"
    ) {
      const ok = window.confirm(
        s.vendor_location_reset_confirm,
      );
      if (!ok) return;
    }
    const c = await detectLocation();
    if (!c) return;
    setUpdatingLocation(true);

    // If they were business_verified, drop them back to identity_linked and
    // clear the manual flag — admin must re-approve after a fresh photo.
    const downgraded =
      vendor.verification_status === "business_verified" ||
      vendor.verification_status === "green_pending";
    const patch: Partial<Vendor> = {
      latitude: c.lat,
      longitude: c.lng,
      ...(downgraded
        ? {
            verification_status: "identity_linked" as VerificationStatus,
            shop_photo_url: null,
            is_manual_verified: false,
          }
        : {}),
    };
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await patchVendorOwn(vendor.id, vendor.phone, patch),
          ),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        toast.error(s.vendor_location_update_failed, { description: error.message });
        return;
      }
      setVendor((prev) =>
        prev
          ? {
              ...prev,
              latitude: c.lat,
              longitude: c.lng,
              ...(downgraded
                ? {
                    verification_status: "identity_linked" as VerificationStatus,
                    shop_photo_url: null,
                    is_manual_verified: false,
                  }
                : {}),
            }
          : prev,
      );
      toast(downgraded ? s.vendor_reverification_required : s.vendor_location_updated, {
        description: downgraded
          ? s.vendor_reverification_body
          : s.vendor_location_updated_body,
      });
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void updateShopLocation(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setUpdatingLocation(false);
    }
  };

  return (
    <AppShell theme="dark">
      {showOnboarding && vendorId && vendor && (
        <VendorOnboarding onComplete={() => setShowOnboarding(false)} />
      )}
      <header className="flex items-center justify-between mb-6" data-testid="vendor-screen">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <button
            type="button"
            onClick={() => navigate("/")}
            className="h-10 w-10 shrink-0 grid place-items-center rounded-xl bg-card border border-border"
            aria-label={s.vendor_back_home}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.3em] text-muted-foreground">{s.vendor_mode_title}</p>
            <h1 className="font-display text-3xl font-bold mt-1">{s.vendor_tagline}</h1>
          </div>
        </div>
        <NotificationBell extraCount={unreadCount} className="shrink-0 ml-3" />
      </header>

      {networkLoadStatus && (
        <NetworkErrorBanner
          status={networkLoadStatus}
          onRetry={
            networkLoadStatus === "failed"
              ? () => setVendorFetchTick((t) => t + 1)
              : undefined
          }
        />
      )}

      {error && !networkLoadStatus && (
        <div className="mb-4 rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}

      {!vendorId && !alreadyRegistered && (
        <>
          <VendorRegistrationWizard
            onRegistered={(id) => void handleWizardRegistered(id)}
            onDuplicatePhone={handleDuplicateRegistrationPhone}
            setParentError={setError}
          />

          <div
            ref={alreadyRegisteredRef}
            className={cn(
              "rounded-2xl transition-colors",
              highlightAlreadyRegistered &&
                "ring-2 ring-amber-500 border border-amber-500/50 bg-amber-500/10 animate-pulse px-2 -mx-2",
            )}
          >
            <div className="relative py-6 animate-fade-up">
              <div className="absolute inset-0 flex items-center" aria-hidden>
                <span className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center text-xs uppercase tracking-wider">
                <span className="bg-background px-3 text-muted-foreground">{s.vendor_or}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setAlreadyRegistered(true);
                setLookupError(null);
              }}
              className="w-full text-center text-sm font-semibold text-primary hover:underline py-2 animate-fade-up"
            >
              {s.vendor_already_registered}
            </button>
          </div>
        </>
      )}

      {!vendorId && alreadyRegistered && (
        <form onSubmit={lookupVendorByPhone} className="space-y-4 animate-fade-up">
          <div>
            <h2 className="font-display text-xl font-bold text-foreground">{s.vendor_find_account_title}</h2>
            <p className="text-sm text-muted-foreground mt-1">
              {s.vendor_find_account_hint}
            </p>
          </div>

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_lookup_phone_label}
            </label>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
              <span className="text-sm text-muted-foreground font-medium">+91</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                placeholder="98765 43210"
                value={lookupPhone}
                onChange={(e) => {
                  setLookupPhone(e.target.value.replace(/\D/g, "").slice(0, 10));
                  setLookupError(null);
                }}
                className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
                autoComplete="tel-national"
              />
            </div>
            {lookupError && <p className="mt-1 text-xs text-destructive">{lookupError}</p>}
          </div>

          <button
            type="submit"
            disabled={lookupLoading}
            className="w-full rounded-2xl bg-primary text-primary-foreground py-3.5 font-semibold shadow-card active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {lookupLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : null}
            {s.vendor_find_btn}
          </button>

          <button
            type="button"
            onClick={() => {
              setAlreadyRegistered(false);
              setLookupError(null);
              setLookupPhone("");
            }}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground py-2"
          >
            {s.vendor_back_to_reg}
          </button>
        </form>
      )}

      {vendorId && loading && !vendor && (
        <div className="grid place-items-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {vendor?.is_banned && (
        <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 animate-fade-up">
          <div className="w-full max-w-md rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-8 text-center space-y-3">
            <p className="text-lg font-bold text-foreground">{s.admin_vendor_banned_title}</p>
            <p className="text-sm text-foreground leading-relaxed">{s.admin_vendor_banned_body}</p>
          </div>
        </div>
      )}

      {vendor && !vendor.is_banned && (() => {
        const profilePhotoCopy = vendorPhotoCopy(vendor.vendor_type, s);

        return (
        <div className="space-y-3 animate-fade-up pb-4">
          {isInTrial && (
            <div className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning text-center">
              {s.vendor_trialDaysLeft(trialDaysLeft!)}
            </div>
          )}
          {trialDaysLeft === 0 && !vendor.subscription_active && (
            <div className="rounded-xl border border-danger/30 bg-danger-muted px-3 py-2 text-xs text-danger text-center">
              {s.vendor_trialExpired}
            </div>
          )}
          {/* Go Live card */}
          <div
            className={cn(
              "mx-4 rounded-2xl border p-6 text-center",
              vendor.is_active
                ? "bg-gradient-to-r from-brand/20 to-brand/5 border-brand/30"
                : "bg-surface border-surface-border",
            )}
          >
            <p
              data-testid="vendor-status-badge"
              className={cn(
                "text-lg font-bold",
                vendor.is_active ? "text-brand" : "text-muted-foreground",
              )}
            >
              {vendor.is_active ? s.vendor_ready : s.vendor_offline_label}
            </p>

            <div className="mt-6 flex justify-center">
              <button
                type="button"
                data-testid="vendor-golive-btn"
                onClick={() => void toggleActive()}
                disabled={checkingOffline}
                aria-pressed={vendor.is_active}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-xl font-semibold transition-all active:scale-95 disabled:opacity-60",
                  vendor.is_active
                    ? "h-11 w-11 bg-primary border-0 text-primary-foreground"
                    : "h-[72px] w-[72px] bg-primary/10 border-2 border-primary text-primary",
                )}
              >
                <Power
                  className={vendor.is_active ? "h-[18px] w-[18px] text-primary-foreground" : "h-[30px] w-[30px] text-primary"}
                  strokeWidth={2.5}
                />
              </button>
            </div>

            {vendor.is_active ? (
              <p className="mt-3 text-xs text-muted-foreground">{s.vendor_tap_offline}</p>
            ) : (
              <>
                <p className="mt-3 text-sm font-medium text-brand">{s.vendor_tap_online}</p>
                <p className="mt-1 text-xs text-muted-foreground">{s.vendor_customers_waiting}</p>
              </>
            )}
            <div className="mt-4 flex justify-center">
              <VerificationBadge vendor={vendor} showLabel />
            </div>

            {!vendor.is_manual_verified && (
              <button
                type="button"
                onClick={() => setVerificationSheetOpen(true)}
                className="mt-3 w-full rounded-xl border border-border bg-muted/40 px-4 py-3 flex items-center gap-3 text-left active:scale-[0.99] transition-transform"
              >
                <span className="flex-1 min-w-0 text-sm font-semibold text-foreground">
                  {vendor.shop_photo_url != null && String(vendor.shop_photo_url).trim() !== ""
                    ? s.vendor_pending_label
                    : s.vendor_complete_verification}
                </span>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
              </button>
            )}

            {isMobileCategory(vendor.category) && (
              <p className="mt-2 text-[11px] text-muted-foreground inline-flex items-center justify-center gap-1">
                <Truck className="h-3 w-3 text-brand" />
                {s.vendor_mobile_gps}
              </p>
            )}

          </div>

          {goLivePromptVisible && (
            <div className="mx-4 rounded-2xl border border-brand/45 bg-brand-muted p-4 text-sm relative">
              <button
                type="button"
                onClick={() => {
                  dismissRegisteredBanner(vendor.id);
                  setGoLivePromptVisible(false);
                }}
                className="absolute top-3 right-3 h-8 w-8 grid place-items-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/40"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
              <p className="font-semibold text-brand pr-10">
                <span aria-hidden>🟢 </span>
                {s.vendor_golive_prompt_title}
              </p>
              <p className="mt-2 text-muted-foreground leading-relaxed pr-2">
                {s.vendor_golive_prompt_body}
              </p>
            </div>
          )}

          <div id="vendor-incoming-orders">
            <IncomingOrdersSection
              vendorId={vendor.id}
              serviceMode={vendor.service_mode ?? "help"}
              onUnreadCount={(n) => setUnreadCount(n)}
              shopName={vendor.shop_name}
              khataAmberLimit={vendor.khata_amber_limit ?? 0}
              khataRedLimit={vendor.khata_red_limit ?? 0}
              cancelReasons={[
                vendor.cancel_reason_1,
                vendor.cancel_reason_2,
                vendor.cancel_reason_3,
                vendor.cancel_reason_4,
              ]}
            />
          </div>

          <button
            type="button"
            onClick={() => navigate("/ledger")}
            className="block mx-4 w-[calc(100%-2rem)] text-left active:scale-[0.99] transition-transform"
          >
            <div className="rounded-2xl border border-border bg-card px-4 py-3 flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span aria-hidden>📒</span>
                {s.khata_book}
              </span>
              <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
            </div>
          </button>

          <section className="mx-4 rounded-2xl border border-surface-border bg-surface p-4">
            <button
              type="button"
              onClick={() => setAnalyticsOpen((o) => !o)}
              className="w-full flex items-center gap-2 text-left active:opacity-90"
              aria-expanded={analyticsOpen}
            >
              <BarChart2 className="h-5 w-5 text-secondary shrink-0" />
              <p className="font-display font-bold flex-1 min-w-0 text-foreground">{s.settings_myAnalytics}</p>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground shrink-0 transition-transform duration-200",
                  analyticsOpen && "rotate-180",
                )}
                aria-hidden
              />
            </button>
            {analyticsOpen && (
              <div className="mt-3">
                <VendorAnalytics
                  hideHeader
                  loading={loading}
                  stats={vendorOrderStats}
                  onTimeRate={
                    typeof vendor.on_time_rate === "number" && Number.isFinite(vendor.on_time_rate)
                      ? vendor.on_time_rate
                      : null
                  }
                />
              </div>
            )}
          </section>

          <Sheet open={verificationSheetOpen} onOpenChange={setVerificationSheetOpen}>
            <SheetContent
              side="bottom"
              className="bg-background border-t border-border rounded-t-2xl max-h-[90vh] overflow-y-auto [&>button]:hidden"
            >
              <div className="flex items-center justify-between border-b border-border pb-3 mb-4 -mt-1">
                <span className="text-sm font-semibold text-foreground">{s.vendor_verification_shop}</span>
                <button
                  type="button"
                  onClick={() => setVerificationSheetOpen(false)}
                  className="text-sm font-semibold text-muted-foreground hover:text-foreground"
                >
                  {s.vendor_close}
                </button>
              </div>

              {/* Verification card */}
              <div className="rounded-2xl bg-card border border-border shadow-card p-5 space-y-4">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-secondary" />
                  <h2 className="font-display font-bold">{s.vendor_verification_heading}</h2>
                </div>

                <Step
                  done={isValidPhone(vendor.phone ?? "")}
                  title={s.vendor_phone_on_file}
                  sub={vendor.phone || s.vendor_not_provided}
                />

                <div className="flex items-start justify-between gap-3">
                  <Step
                    done={vendor.upi_verified}
                    title={s.vendor_upi_bank_match}
                    sub={vendor.upi_id}
                  />
                  {!vendor.upi_verified && (
                    <button
                      onClick={verifyUpi}
                      disabled={verifyingUpi}
                      className="text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 disabled:opacity-60 shrink-0"
                    >
                      {verifyingUpi ? s.vendor_checking : s.vendor_verify_upi_btn}
                    </button>
                  )}
                </div>

                {(vendor.latitude == null || vendor.longitude == null) &&
                  vendor.vendor_type !== "visiting" && (
                  <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3">
                    <p className="text-sm font-semibold text-amber-200">{s.vendor_location_missing_title}</p>
                    <p className="mt-1 text-xs text-amber-100/90">
                      {s.vendor_location_missing_body}
                    </p>
                    <button
                      type="button"
                      onClick={updateShopLocation}
                      disabled={updatingLocation}
                      className="mt-3 inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground disabled:opacity-60"
                    >
                      {updatingLocation ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MapPin className="h-3.5 w-3.5" />}
                      {s.vendor_set_location_btn}
                    </button>
                  </div>
                )}
                {(vendor.latitude == null || vendor.longitude == null) &&
                  vendor.vendor_type === "visiting" && (
                  <p className="text-xs text-muted-foreground">{s.vendor_visiting_location_hint}</p>
                )}

                <div className="flex items-start justify-between gap-3">
                  <Step
                    done={!!vendor.shop_photo_url}
                    title={profilePhotoCopy.title}
                    sub={
                      vendor.shop_photo_url
                        ? s.vendor_photo_captured
                        : vendor.latitude == null || vendor.longitude == null
                          ? s.vendor_location_set_first_photo
                          : profilePhotoCopy.hint
                    }
                  />
                  <button
                    onClick={() => setCameraOpen(true)}
                    disabled={vendor.latitude == null || vendor.longitude == null}
                    title={
                      vendor.latitude == null || vendor.longitude == null
                        ? s.vendor_location_set_first_photo
                        : undefined
                    }
                    className="text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 shrink-0 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {vendor.shop_photo_url ? s.vendor_reshoot : s.vendor_capture}
                  </button>
                </div>

                {vendor.shop_photo_url && (
                  <img
                    src={vendor.shop_photo_url}
                    alt={s.vendor_captured_shop}
                    className="w-full rounded-xl border border-border"
                  />
                )}

                <div className="flex items-start justify-between gap-3">
                  <Step
                    done={!!vendor.photo_selfie}
                    title={s.vendor_selfie_title}
                    sub={
                      vendor.photo_selfie
                        ? s.vendor_selfie_captured
                        : !vendor.shop_photo_url
                          ? profilePhotoCopy.hint
                          : s.vendor_selfie_subtitle
                    }
                  />
                  <button
                    onClick={openSelfieCamera}
                    disabled={!vendor.shop_photo_url}
                    title={!vendor.shop_photo_url ? profilePhotoCopy.hint : undefined}
                    className="text-xs font-semibold rounded-lg bg-primary text-primary-foreground px-3 py-2 shrink-0 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    {vendor.photo_selfie ? s.vendor_selfie_reshoot : s.vendor_selfie_capture}
                  </button>
                </div>

                {vendor.photo_selfie && (
                  <img
                    src={vendor.photo_selfie}
                    alt={s.vendor_selfie_title}
                    className="w-full max-w-xs mx-auto rounded-xl border border-border"
                  />
                )}

                <div className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
                  {s.vendor_badge_approval} ({vendor.is_manual_verified ? s.vendor_approved : s.vendor_approval_pending}).
                </div>
              </div>

              <div id="vendor-verification-banner">
                <VendorPostRegistrationGuidance vendor={vendor} />
              </div>

              {/* Shop info */}
              <div className="rounded-2xl bg-muted/60 p-4 text-sm space-y-2 mt-4">
                <div>
                  <p className="font-semibold">{vendor.shop_name}</p>
                  <p className="text-muted-foreground">{vendor.name} · {getLabel(vendor.category)}</p>
                  <p className="text-muted-foreground text-xs">📞 {vendor.phone}</p>
                  <p className="text-muted-foreground text-xs">UPI: {vendor.upi_id}</p>
                  {vendor.latitude != null && vendor.longitude != null && (
                    <p className="text-muted-foreground text-xs">
                      📍 {vendor.latitude.toFixed(4)}, {vendor.longitude.toFixed(4)}
                    </p>
                  )}
                </div>
                {vendor.latitude != null && vendor.longitude != null && (
                  <button
                    onClick={updateShopLocation}
                    disabled={updatingLocation}
                    className="w-full rounded-xl border-2 border-border py-2.5 text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {updatingLocation ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <MapPin className="h-4 w-4" />
                    )}
                    {s.vendor_update_location}
                  </button>
                )}
                {(vendor.verification_status === "business_verified" ||
                  vendor.verification_status === "green_pending") && (
                  <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1">
                    <AlertTriangle className="h-3 w-3 text-accent mt-0.5 shrink-0" />
                    {s.vendor_location_reset_warning}
                  </p>
                )}
                <button
                  type="button"
                  onClick={openEditShop}
                  className="w-full rounded-xl border border-border py-2.5 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-card transition-colors"
                >
                  <Pencil className="h-4 w-4" />
                  Edit Shop Details
                </button>
              </div>

              <VendorNoteEditor
                vendorId={vendor.id}
                initialNote={vendor.vendor_note}
                onSaved={(newNote) =>
                  setVendor({ ...vendor, vendor_note: newNote || null })
                }
              />
            </SheetContent>
          </Sheet>

          <Sheet open={editShopOpen} onOpenChange={setEditShopOpen}>
            <SheetContent
              side="bottom"
              className="bg-background border-t border-border rounded-t-2xl max-h-[90vh] overflow-y-auto [&>button]:hidden"
            >
              <SheetHeader className="border-b border-border pb-3 mb-4">
                <SheetTitle className="text-left font-display">Edit Shop Details</SheetTitle>
              </SheetHeader>

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.reg_where_work_from}
                  </label>
                  <div className="mt-2 grid grid-cols-1 gap-2">
                    {(
                      [
                        { value: "shop" as const, emoji: "🏪", title: s.reg_base_shop, desc: s.reg_base_shop_desc },
                        { value: "home" as const, emoji: "🏠", title: s.reg_base_home, desc: s.reg_base_home_desc },
                        { value: "none" as const, emoji: "🚫", title: s.reg_base_none, desc: s.reg_base_none_desc },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setEditBaseType(opt.value);
                          const vt = baseTypeToVendorType(opt.value);
                          if (vt) setEditVendorType(vt);
                        }}
                        className={cn(
                          "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                          "bg-surface border-surface-border",
                          editBaseType === opt.value &&
                            "border-primary bg-primary/15 ring-1 ring-primary/30",
                        )}
                      >
                        <p className="text-base font-display font-bold text-foreground leading-tight">
                          {opt.emoji} {opt.title}
                        </p>
                        <p className="mt-1 text-[10px] text-muted-foreground leading-snug">
                          {opt.desc}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                {editBaseType === "shop" && (
                  <Field
                    label={s.vendor_shop_name}
                    value={editShopName}
                    onChange={setEditShopName}
                    placeholder={s.vendor_shop_placeholder}
                    required
                    error={
                      editShopName.length > 0 && !editShopFieldOk
                        ? s.vendor_specify_hint
                        : undefined
                    }
                  />
                )}
                {editBaseType === "home" && (
                  <Field
                    label={s.vendor_brand_name_optional}
                    value={editShopName}
                    onChange={setEditShopName}
                    placeholder={s.vendor_brand_placeholder}
                    error={editShopNameInvalid ? s.vendor_specify_hint : undefined}
                  />
                )}

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {s.vendor_categories_label}
                    </label>
                    <span className="text-xs text-muted-foreground">
                      {s.vendor_categories_selected(editSelectedCategoryIds.length)}
                    </span>
                  </div>
                  {editCategoriesLoading ? (
                    <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {s.vendor_understanding}
                    </p>
                  ) : editAvailableCategories.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {editAvailableCategories.map((cat) => {
                        const selected = editSelectedCategoryIds.includes(cat.id);
                        const atMax = editSelectedCategoryIds.length >= MAX_REG_CATEGORIES;
                        const disabled = !selected && atMax;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            data-testid={`vendor-edit-category-${cat.id}`}
                            disabled={disabled}
                            onClick={() => toggleEditCategory(cat.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                              selected
                                ? "border-primary bg-primary/20 text-foreground ring-1 ring-primary/30"
                                : "border-border bg-card text-foreground",
                              disabled && "opacity-40 cursor-not-allowed",
                            )}
                          >
                            <span>
                              {cat.emoji} {getLabel(cat.label)}
                            </span>
                            <span className="text-[10px] font-normal text-muted-foreground">
                              {categoryServiceModeChipLabel(cat.service_mode, s)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {editSelectedCategoryIds.length === 0 && !editCategoriesLoading && (
                    <p className="mt-2 text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
                  )}
                </div>

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.reg_edit_reach_label}
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        { value: "customer" as const, label: s.reg_reach_customer },
                        { value: "vendor" as const, label: s.reg_reach_vendor },
                        { value: "both" as const, label: s.reg_reach_both },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setEditReachChoice(opt.value)}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-sm font-medium",
                          editReachChoice === opt.value
                            ? "border-primary bg-primary/20"
                            : "border-border",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {editNeedsRadius && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {s.vendor_radius_label}
                    </p>
                    <div className="mt-3">
                      <ServiceRadiusChips
                        value={editServiceRadiusKm}
                        onChange={setEditServiceRadiusKm}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {s.reg_edit_availability_label}
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(
                      [
                        { mode: "help" as const, label: s.reg_avail_help },
                        { mode: "delivery" as const, label: s.reg_avail_delivery },
                        { mode: "appointment" as const, label: s.reg_avail_appointment },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.mode}
                        type="button"
                        onClick={() =>
                          setEditAvailabilityModes((prev) =>
                            prev.includes(opt.mode)
                              ? prev.filter((m) => m !== opt.mode)
                              : [...prev, opt.mode],
                          )
                        }
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-sm font-medium",
                          editAvailabilityModes.includes(opt.mode)
                            ? "border-primary bg-primary/20"
                            : "border-border",
                        )}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <Field
                  label={s.vendor_phone_label}
                  value={editPhone}
                  onChange={setEditPhone}
                  placeholder={s.vendor_phone_placeholder}
                  required
                />
                <Field
                  label={s.vendor_upi_label}
                  value={editUpiId}
                  onChange={setEditUpiId}
                  placeholder={s.vendor_upi_placeholder}
                />

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditShopOpen(false)}
                    className="flex-1 rounded-2xl border border-border py-3.5 text-sm font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveShopDetails()}
                    disabled={!editShopSaveReady || savingShopDetails}
                    className="flex-1 rounded-2xl bg-primary text-primary-foreground py-3.5 text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {savingShopDetails ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Save
                  </button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
        );
      })()}

      <AlertDialog open={offlineConfirmOpen} onOpenChange={setOfflineConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.vendor_offline_active_orders_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.vendor_offline_active_orders_message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-2">
            <AlertDialogCancel className="mt-0">{s.vendor_stay_online}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void confirmGoOfflineAnyway()}
            >
              {s.vendor_go_offline_anyway}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <LiveCamera
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleShopPhoto}
      />
      <LiveCamera
        open={selfieCameraOpen}
        onClose={() => setSelfieCameraOpen(false)}
        onCapture={handleSelfiePhoto}
        facing="front"
        requireLocation={false}
      />
    </AppShell>
  );
};

const Field = ({
  label, value, onChange, placeholder, required, error, onBlur,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  error?: string;
  onBlur?: () => void;
}) => {
  const { s } = useLanguage();
  void s;

  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        required={required}
        className={`mt-1 w-full bg-card border rounded-xl px-4 py-3.5 text-base focus:outline-none focus:ring-2 ${
          error ? "border-destructive focus:ring-destructive" : "border-border focus:ring-primary"
        }`}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
};

const Step = ({ done, title, sub }: { done: boolean; title: string; sub: string }) => {
  const { s } = useLanguage();
  void s;

  return (
    <div className="flex-1 flex items-start gap-3">
      <span
        className={`mt-0.5 h-5 w-5 rounded-full grid place-items-center shrink-0 ${
          done ? "bg-secondary text-secondary-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground truncate">{sub}</p>
      </div>
    </div>
  );
};

export default VendorMode;
