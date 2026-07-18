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
  distanceMeters,
  useCategoryLabel,
  useServiceModeLabel,
  invokeNotifyAdmin,
  invokeRegisterVendor,
  invokeAttachPendingCategory,
  invokeSuggestCategory,
  type CategorySuggestionResult,
} from "@/lib/supabase";
import { patchVendorOwn } from "@/lib/vendorPatch";
import { fetchVendorByPhoneLogin, fetchVendorOwn } from "@/lib/vendorRead";
import { getUserPhone, saveUserPhone } from "@/lib/userIdentity";
import {
  startHelpLiveTracking,
  stopHelpLiveTracking,
} from "@/lib/vendorBackgroundLocation";
import { vendorOffersHelp } from "@/lib/vendorTrackingPolicy";
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
import { TrustBadge } from "@/components/TrustBadge";
import { IncomingOrdersSection } from "@/components/IncomingOrdersSection";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import {
  VendorAnalytics,
  type VendorOrderStats,
  type VendorCategoryStat,
} from "@/components/vendor/VendorAnalytics";
import { buildCategoryOrderStats } from "@/lib/categoryScopedVendor";
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

async function fetchBlockingActiveOrders(
  vendorId: string,
  vendorPhone: string | null | undefined,
  serviceMode: string | null | undefined,
): Promise<BlockingOfflineOrder[]> {
  const phone = vendorPhone?.trim();
  if (!phone) return [];
  const { data, error } = await supabase.rpc("get_vendor_blocking_active_orders", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
  });
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
  const [vendorCategoryStats, setVendorCategoryStats] = useState<VendorCategoryStat[]>([]);
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
  const [availabilityModes, setAvailabilityModes] = useState<string[]>([]);


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
        const vendorPhone = getUserPhone()?.trim();
        const { data, error: fetchError } = await withNetworkRetry(
          async () => {
            if (vendorPhone) {
              const own = await fetchVendorOwn(vendorId, vendorPhone);
              if (own.error) throw own.error;
              return { data: own.data, error: null };
            }
            return throwOnSupabaseNetworkError(
              await supabase
                .from("vendors")
                .select("*")
                .eq("id", vendorId)
                .maybeSingle()
                .retry(false),
            );
          },
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
          const { data: modeRows } = await supabase
            .from("vendor_availability_modes")
            .select("mode")
            .eq("vendor_id", vendorId);
          if (!cancelled) {
            setAvailabilityModes((modeRows ?? []).map((r) => String(r.mode)));
          }
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
    const vendorPhoneForStats = vendor.phone?.trim();
    if (!vendorPhoneForStats) return;
    let cancelled = false;

    void (async () => {
      const { data } = await supabase.rpc("get_vendor_order_stats_rows", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhoneForStats,
      });

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

      const catIds = [
        ...new Set(
          orders
            .map((o) => o.category_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        ),
      ];
      const labelByCategoryId = new Map<string, string>();
      if (catIds.length > 0) {
        const { data: cats } = await supabase
          .from("categories")
          .select("id, label")
          .in("id", catIds);
        for (const c of cats ?? []) {
          labelByCategoryId.set(c.id, getLabel(c.label));
        }
      }
      if (cancelled) return;
      setVendorCategoryStats(
        buildCategoryOrderStats(orders, labelByCategoryId).map((row) => ({
          categoryId: row.categoryId,
          label: row.label,
          total: row.total,
          fulfilled: row.fulfilled,
          onTimeRate: row.onTimeRate,
        })),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [vendor?.id, vendor?.phone]);

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

  const handleWizardRegistered = async (newVendorId: string, vendorPhone: string) => {
    const { data: vendorRow, error: vendorFetchError } = await fetchVendorOwn(
      newVendorId,
      vendorPhone,
    );
    if (vendorFetchError || !vendorRow) {
      setError(vendorFetchError?.message ?? "Could not load registered vendor");
      return;
    }
    saveUserPhone(vendorPhone);
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
      const { data: found, error } = await fetchVendorByPhoneLogin(digits);
      if (error) {
        setLookupError(s.vendor_not_found);
        return;
      }
      if (found) {
        if (found.phone.startsWith("deleted_")) {
          toast.error(s.vendor_phone_register_blocked);
          return;
        }
        saveUserPhone(digits);
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

    const offersHelp = vendorOffersHelp({
      service_mode: vendor.service_mode,
      availability_modes: availabilityModes,
    });

    let liveCoords: { lat: number; lng: number } | null = null;
    // Case 1: Help vendors need a fresh fix when going live (continuous tracking follows).
    if (next && offersHelp) {
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
        if (offersHelp) {
          void startHelpLiveTracking({
            vendorId: vendor.id,
            vendorPhone: vendor.phone,
          });
        }
      } else {
        void stopHelpLiveTracking();
      }

      toast(next ? s.vendor_you_are_live : s.vendor_you_are_offline, {
        description: next
          ? liveCoords
            ? s.vendor_live_body
            : s.vendor_live_body_short
          : s.vendor_offline_body,
      });
      if (next && !vendor.is_manual_verified) {
        toast.info(s.vendor_golive_unverified_nudge);
      }
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
        vendor.phone,
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
    setOfflineConfirmOpen(false);
    setOfflineBlockingOrders([]);
    await applyActiveState(false);
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
            onRegistered={(id, phone) => void handleWizardRegistered(id, phone)}
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
              <TrustBadge
                vendorId={vendor.id}
                isManualVerified={vendor.is_manual_verified}
                showLabel
              />
            </div>

            {!vendor.is_manual_verified && (
              <button
                type="button"
                onClick={() =>
                  navigate("/settings", { state: { vendorSettingsTab: "business" } })
                }
                className="mt-3 w-full rounded-xl border border-border bg-muted/40 px-4 py-3 flex items-center gap-3 text-left active:scale-[0.99] transition-transform"
              >
                <span className="flex-1 min-w-0 text-sm font-semibold text-foreground">
                  {s.vendor_complete_verification_settings}
                </span>
                <ChevronRight className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden />
              </button>
            )}

            {vendorOffersHelp({
              service_mode: vendor.service_mode,
              availability_modes: availabilityModes,
            }) && (
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
                  categoryStats={vendorCategoryStats}
                  onTimeRate={
                    typeof vendor.on_time_rate === "number" && Number.isFinite(vendor.on_time_rate)
                      ? vendor.on_time_rate
                      : null
                  }
                />
              </div>
            )}
          </section>

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

    </AppShell>
  );
};


export default VendorMode;
