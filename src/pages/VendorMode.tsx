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
import { saveNotification } from "@/lib/notifications";
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

const MAX_REG_CATEGORIES = 5;

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

// Heuristic gibberish detector: rejects keyboard mashing like "asdfasdf"
// or strings without any vowels. Tuned to be permissive for real names.
function looksLikeGibberish(s: string) {
  const t = s.trim().toLowerCase();
  if (t.length < 2) return true;
  if (!/[aeiouy]/.test(t)) return true;                  // no vowels
  if (/(.)\1{3,}/.test(t)) return true;                  // 4+ repeats: "aaaa"
  if (/^[asdfghjkl;]+$/.test(t) && t.length > 4) return true; // home-row mash
  if (/^[qwertyuiop]+$/.test(t) && t.length > 4) return true;
  return false;
}

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

function resolveRegistrationShopName(
  vendorType: VendorTypeValue,
  ownerName: string,
  shopNameValue: string,
): string {
  const owner = ownerName.trim();
  const shop = shopNameValue.trim();
  if (vendorType === "visiting") return owner;
  if (vendorType === "home") return shop || owner;
  return shop;
}

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
  const [phone, setPhone] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);

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
  const [savingShopDetails, setSavingShopDetails] = useState(false);

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
    if (!isTogglingRef.current) {
      setLoading(true);
      supabase
        .from("vendors")
        .select("*")
        .eq("id", vendorId)
        .maybeSingle()
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) setError(error.message);
          else if (!data) {
            localStorage.removeItem(STORAGE_KEY);
            setVendorId(null);
          } else setVendor(data as Vendor);
          setLoading(false);
        });
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
        if (!vendor?.is_active) return;
        const { error } = await supabase
          .from("vendors")
          .update({ last_updated: new Date().toISOString() })
          .eq("id", vendorId);
        if (error) console.error("Vendor ping failed:", error.message);
      })();
    }, 20 * 60 * 1000);

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      window.clearInterval(pingInterval);
    };
  }, [vendorId, vendor?.is_active]);

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
        resolve(null);
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const c = { lat: p.coords.latitude, lng: p.coords.longitude };
          setCoords(c);
          setLocating(false);
          if (!opts?.silent) toast.success(s.vendor_location_captured);
          resolve(c);
        },
        (err) => {
          setLocating(false);
          if (!opts?.silent) toast.error(s.vendor_location_failed, { description: err.message });
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
      if (cancelled || !c) return;
      const { error } = await supabase
        .from("vendors")
        .update({ latitude: c.lat, longitude: c.lng })
        .eq("id", vendor.id);
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
    const result = await invokeSuggestCategory({ description: desc });
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

  const toggleEditCategory = (categoryId: string) => {
    let next: string[];
    if (editSelectedCategoryIds.includes(categoryId)) {
      next = editSelectedCategoryIds.filter((id) => id !== categoryId);
    } else {
      if (editSelectedCategoryIds.length >= MAX_REG_CATEGORIES) return;
      next = [...editSelectedCategoryIds, categoryId];
    }
    setEditSelectedCategoryIds(next);
    setEditSelectedCategories(
      next
        .map(
          (id) =>
            editAvailableCategories.find((c) => c.id === id) ??
            editSelectedCategories.find((c) => c.id === id),
        )
        .filter((c): c is RegCategoryRow => c != null),
    );
  };

  const openEditShop = () => {
    if (!vendor) return;
    setEditShopName(vendor.shop_name ?? "");
    setEditPhone(vendor.phone ?? "");
    setEditUpiId(vendor.upi_id ?? "");
    const vt = vendor.vendor_type;
    setEditVendorType(
      vt === "shop" || vt === "home" || vt === "visiting" ? vt : "shop",
    );
    setEditAvailableCategories([]);
    setEditSelectedCategories([]);
    setEditSelectedCategoryIds([]);
    setEditCategoriesLoading(true);
    setEditShopOpen(true);

    void (async () => {
      const [availResult, vcResult] = await Promise.all([
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

      setEditSelectedCategories(selected);
      setEditSelectedCategoryIds(selected.map((c) => c.id));
      setEditCategoriesLoading(false);
    })();
  };

  const saveShopDetails = async () => {
    if (!vendor) return;
    const primaryCategory =
      editAvailableCategories.find((c) => c.id === editSelectedCategoryIds[0]) ??
      editSelectedCategories[0] ??
      null;
    const primaryLabel = primaryCategory?.label ?? "";
    const primaryServiceMode = (primaryCategory?.service_mode ??
      vendor.service_mode ??
      "") as ServiceModeValue;
    const resolvedShopName = resolveRegistrationShopName(
      editVendorType,
      vendor.name,
      editShopName,
    );

    if (
      editVendorType === "" ||
      !resolvedShopName.trim() ||
      editSelectedCategoryIds.length === 0 ||
      !primaryLabel ||
      !primaryServiceMode ||
      !editPhone.trim()
    ) {
      return;
    }
    setSavingShopDetails(true);

    const { error } = await supabase
      .from("vendors")
      .update({
        shop_name: resolvedShopName.trim(),
        category: primaryLabel,
        service_mode: primaryServiceMode,
        vendor_type: editVendorType,
        phone: editPhone.trim(),
        upi_id: editUpiId.trim() || null,
        is_manual_verified: false,
        verification_status: "identity_linked",
        shop_photo_url: null,
        upi_verified: false,
      })
      .eq("id", vendor.id);

    if (error) {
      setSavingShopDetails(false);
      toast.error(s.vendor_update_failed);
      return;
    }

    const { error: deleteVcError } = await supabase
      .from("vendor_categories")
      .delete()
      .eq("vendor_id", vendor.id);
    if (deleteVcError) {
      console.error("vendor_categories delete", deleteVcError);
      setSavingShopDetails(false);
      toast.error("Failed to update categories");
      return;
    }

    const needsReview = editSelectedCategoryIds.length >= 3;
    const { error: insertVcError } = await supabase.from("vendor_categories").insert(
      editSelectedCategoryIds.map((categoryId, index) => {
        const cat =
          editAvailableCategories.find((c) => c.id === categoryId) ??
          editSelectedCategories.find((c) => c.id === categoryId);
        return {
          vendor_id: vendor.id,
          category_id: categoryId,
          is_primary: index === 0,
          status: "approved",
          needs_review: needsReview,
          service_mode: cat?.service_mode ?? primaryServiceMode,
        };
      }),
    );
    setSavingShopDetails(false);
    if (insertVcError) {
      console.error("vendor_categories insert", insertVcError);
      toast.error("Shop saved but categories failed to update");
      return;
    }

    setVendor((prev) =>
      prev
        ? {
            ...prev,
            shop_name: resolvedShopName.trim(),
            category: primaryLabel,
            service_mode: primaryServiceMode,
            vendor_type: editVendorType,
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
      { vendor_id: vendor.id },
    );
    setEditShopOpen(false);
    toast.success("Shop details updated. Admin will re-verify your account.");
  };

  const editShopNameInvalid =
    editShopName.trim().length > 0 &&
    (editShopName.trim().length <= 1 || looksLikeGibberish(editShopName));
  const editShopFieldOk =
    editVendorType === "shop"
      ? editShopName.trim().length > 1 && !looksLikeGibberish(editShopName)
      : editVendorType === "home"
        ? !editShopNameInvalid
        : editVendorType === "visiting";

  const editShopSaveReady =
    editVendorType !== "" &&
    editShopFieldOk &&
    editSelectedCategoryIds.length > 0 &&
    editPhone.trim().length > 0;

  const register = async (e: FormEvent) => {
    e.preventDefault();
    if (!vendorTypeOk) {
      toast.error(s.vendor_type_required);
      return;
    }
    if (!nameOk) {
      toast.error(s.vendor_name_invalid, {
        description: s.vendor_name_invalid_body,
      });
      return;
    }
    if (vendorType === "shop" && !shopOk) {
      toast.error(s.vendor_shopname_invalid, {
        description: s.vendor_shopname_invalid_body,
      });
      return;
    }
    if (vendorType === "home" && homeShopInvalid) {
      toast.error(s.vendor_shopname_invalid, {
        description: s.vendor_shopname_invalid_body,
      });
      return;
    }
    if (!categoryOk) {
      toast.error(s.vendor_categories_required, {
        description: s.vendor_categories_pick,
      });
      return;
    }
    if (serviceMode === "") {
      toast.error(s.vendor_choose_service, {
        description: s.vendor_choose_service_body,
      });
      return;
    }
    if (!phoneOk) {
      toast.error(s.vendor_phone_invalid, {
        description: s.vendor_phone_invalid_body,
      });
      return;
    }
    if (!upiFmtOk) {
      toast.error(s.vendor_upi_invalid, {
        description: s.vendor_upi_id_format_invalid,
      });
      return;
    }
    setLoading(true);
    setError(null);

    const primaryServiceMode =
      (pendingNewCategoryCreate?.service_mode as ServiceModeValue) ||
      (primaryCategory?.service_mode as ServiceModeValue) ||
      serviceMode;

    const profileStatus: "draft" | "complete" =
      vendorType === "visiting"
        ? "complete"
        : coords?.lat != null && coords?.lng != null
          ? "complete"
          : "draft";

    if ((vendorType === "shop" || vendorType === "home") && !coords) {
      toast(s.vendor_gps_missing_draft);
    }

    const categoryIdsForRpc = [...selectedCategoryIds];
    const categoryServiceModes = categoryIdsForRpc.map((categoryId) => {
      const cat = allRegCategories.find((c) => c.id === categoryId);
      return cat?.service_mode ?? primaryServiceMode;
    });

    const registerResult = await invokeRegisterVendor({
      name: name.trim(),
      shop_name: resolveRegistrationShopName(vendorType, name, shopName),
      category: effectiveCategory,
      phone: phone.trim(),
      upi_id: upi.trim(),
      service_mode: primaryServiceMode,
      vendor_type: vendorType,
      vendor_note: vendorNote.trim() || null,
      latitude: coords?.lat ?? null,
      longitude: coords?.lng ?? null,
      referral_code: referralCodeFromPhone(phone.trim()),
      profile_status: profileStatus,
      category_ids: categoryIdsForRpc,
      category_service_modes: categoryServiceModes,
    });

    if (!registerResult.ok) {
      setLoading(false);
      if (isDuplicateVendorPhoneError(registerResult)) {
        const phoneValue = phone.trim();
        const { data: existingVendor } = await supabase
          .from("vendors")
          .select("is_banned, deletion_requested_at, phone")
          .eq("phone", phoneValue)
          .single();
        if (
          existingVendor &&
          (existingVendor.is_banned ||
            existingVendor.deletion_requested_at != null ||
            existingVendor.phone.startsWith("deleted_"))
        ) {
          toast.error(s.vendor_lookup_unavailable);
          setError(null);
          return;
        }
        toast.error(s.vendor_duplicate_phone);
        setError(null);
        setHighlightAlreadyRegistered(true);
        window.setTimeout(() => {
          alreadyRegisteredRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 100);
        window.setTimeout(() => setHighlightAlreadyRegistered(false), 2500);
        return;
      }
      setError(registerResult.error);
      return;
    }

    const newVendorId = registerResult.vendorId;
    let resolvedPrimaryServiceMode = primaryServiceMode;
    let resolvedCategoryLabel = effectiveCategory;

    if (pendingNewCategoryCreate) {
      const created = await invokeSuggestCategory({
        description: pendingNewCategoryCreate.description,
        vendor_id: newVendorId,
        create_pending: true,
      });
      if (created.success && created.category_id) {
        resolvedPrimaryServiceMode = (created.service_mode ??
          pendingNewCategoryCreate.service_mode) as ServiceModeValue;
        resolvedCategoryLabel =
          created.category_name ?? pendingNewCategoryCreate.category_name;

        const attachResult = await invokeAttachPendingCategory({
          vendorId: newVendorId,
          categoryId: created.category_id,
          serviceMode: resolvedPrimaryServiceMode,
        });
        if (!attachResult.ok) {
          console.error("attach_pending_category failed", attachResult.error);
        } else {
          const { error: vendorUpdateError } = await supabase
            .from("vendors")
            .update({
              category: resolvedCategoryLabel,
              service_mode: resolvedPrimaryServiceMode,
            })
            .eq("id", newVendorId);
          if (vendorUpdateError) {
            console.error("vendor update after pending create", vendorUpdateError);
          }
        }

        if (created.outcome === "new_auto_approved") {
          toast.success(
            s.category_approved_body.replace(
              "{label}",
              created.category_name ?? pendingNewCategoryCreate.category_name,
            ),
          );
        }
      } else {
        console.error(
          "pending category create failed",
          created.error ?? s.vendor_category_create_failed,
        );
      }
    }

    const { data: vendorRow, error: vendorFetchError } = await supabase
      .from("vendors")
      .select("*")
      .eq("id", newVendorId)
      .single();
    if (vendorFetchError || !vendorRow) {
      setLoading(false);
      setError(vendorFetchError?.message ?? "Could not load registered vendor");
      return;
    }

    setLoading(false);
    localStorage.setItem(STORAGE_KEY, newVendorId);
    notifyVendorIdChanged();
    setVendorId(newVendorId);
    setVendor(vendorRow as Vendor);
    const adminTitle = s.vendor_admin_notify_title;
    const adminBody = `${name.trim()} — ${resolvedCategoryLabel} (${resolvedPrimaryServiceMode})`;
    void invokeNotifyAdmin(adminTitle, adminBody, { vendor_id: newVendorId });
    const { data: adminConfig } = await supabase
      .from("app_config")
      .select("value")
      .eq("key", "admin_phone")
      .maybeSingle();
    const adminPhone = adminConfig?.value?.trim() || "8888169446";
    saveNotification({
      userPhone: adminPhone,
      type: "new_vendor",
      title: adminTitle,
      body: adminBody,
      route: "vendor",
      routeParams: { vendor_id: newVendorId },
      isInformational: true,
    });
    if (referralCodeInput.trim()) {
      try {
        const referralResp = await fetch(`${SUPABASE_URL}/functions/v1/process-vendor-referral`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            new_vendor_id: newVendorId,
            referral_code: referralCodeInput.trim(),
          }),
        });
        const referralBody = (await referralResp.json()) as {
          success?: boolean;
          ok?: boolean;
          reason?: string;
        };
        if (referralBody.reason === "already_referred") {
          toast.error(s.referral_already_used);
        } else if (referralResp.ok && referralBody.success) {
          toast.success(s.referral_code_applied);
        } else {
          toast.error(s.referral_code_invalid);
        }
      } catch {
        toast.error(s.referral_code_invalid);
      }
    }
    toast.success(s.vendor_welcome_title, {
      description: s.vendor_welcome_body,
    });
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
          toast.error(s.vendor_lookup_unavailable);
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
      } catch {
        setVendor({ ...vendor, is_active: !next });
        toast.error(s.vendor_location_required, {
          description: s.vendor_location_required_body,
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

    isTogglingRef.current = true;
    try {
      const { error } = await supabase
        .from("vendors")
        .update(patch)
        .eq("id", vendor.id);
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
      saveNotification({
        userPhone,
        type: "order_update",
        title: s.user_vendor_offline_title,
        body: s.user_vendor_offline_body,
        route: "my-orders",
        routeParams: { order_id: orderId },
        isInformational: false,
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
      saveNotification({
        userPhone,
        type: "order_update",
        title: s.goOffline_pendingOrderNotify_title,
        body: s.goOffline_pendingOrderNotify_body,
        route: "my-orders",
        routeParams: { order_id: orderId },
        isInformational: false,
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
    const { error } = await supabase
      .from("vendors")
      .update({ upi_verified: true })
      .eq("id", vendor.id);
    setVerifyingUpi(false);
    if (error) {
      toast.error(s.vendor_upi_check_failed, { description: error.message });
      return;
    }
    void checkAndNotifyAdminGreenReady(vendor.id);
    setVendor((prev) => (prev ? { ...prev, upi_verified: true } : prev));
    toast.success(`${s.vendor_upi_verified}${bank.toUpperCase()}`, {
      description: s.vendor_upi_bank_valid,
    });
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
    const { error: upErr } = await supabase.storage
      .from(SHOP_PHOTOS_BUCKET)
      .upload(path, shot.blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (upErr) {
      toast.error(s.vendor_upload_failed, { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(SHOP_PHOTOS_BUCKET).getPublicUrl(path);

    // 3. Promote to business_verified (admin still gates the green glow).
    const { error: updErr } = await supabase
      .from("vendors")
      .update({
        shop_photo_url: pub.publicUrl,
        verification_status: "business_verified" as VerificationStatus,
        gps_match_distance: gpsMatchDistance,
        ...(hasShopLocation
          ? {}
          : {
              latitude: shot.coords.lat,
              longitude: shot.coords.lng,
            }),
      })
      .eq("id", vendor.id);
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
  };

  const handleSelfiePhoto = async (shot: CapturedShot) => {
    if (!vendor) return;
    setSelfieCameraOpen(false);

    const path = `${vendor.id}/selfie.jpg`;
    const { error: upErr } = await supabase.storage
      .from(VENDOR_SELFIES_BUCKET)
      .upload(path, shot.blob, {
        contentType: "image/jpeg",
        upsert: true,
      });
    if (upErr) {
      toast.error(s.vendor_upload_failed, { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from(VENDOR_SELFIES_BUCKET).getPublicUrl(path);

    const { error: updErr } = await supabase
      .from("vendors")
      .update({ photo_selfie: pub.publicUrl })
      .eq("id", vendor.id);
    if (updErr) {
      toast.error(s.vendor_save_verification_failed, { description: updErr.message });
      return;
    }

    const { error: verErr } = await supabase.from("vendor_verification").insert({
      vendor_id: vendor.id,
      check_type: "photo_selfie",
      status: "pending",
      checked_by: "system",
      is_latest: true,
    });
    if (verErr) {
      console.error("photo_selfie verification insert", verErr);
    }

    setVendor((prev) => (prev ? { ...prev, photo_selfie: pub.publicUrl } : prev));
    toast.success(s.vendor_selfie_captured);
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
    const { error } = await supabase
      .from("vendors")
      .update(patch)
      .eq("id", vendor.id);
    setUpdatingLocation(false);
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

      {error && (
        <div className="mb-4 rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive break-words">{error}</p>
        </div>
      )}

      {!vendorId && !alreadyRegistered && (
        <>
          <form onSubmit={register} className="space-y-3 animate-fade-up">
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_type_label}
            </label>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    value: "shop" as const,
                    emoji: "🏪",
                    title: s.vendor_type_shop,
                    desc: s.vendor_type_shop_desc,
                  },
                  {
                    value: "home" as const,
                    emoji: "🏠",
                    title: s.vendor_type_home,
                    desc: s.vendor_type_home_desc,
                  },
                  {
                    value: "visiting" as const,
                    emoji: "🚗",
                    title: s.vendor_type_visiting,
                    desc: s.vendor_type_visiting_desc,
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setVendorType(opt.value)}
                  className={cn(
                    "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                    "bg-surface border-surface-border",
                    vendorType === opt.value &&
                      "border-primary bg-primary/15 ring-1 ring-primary/30",
                  )}
                >
                  <p className="text-base font-display font-bold text-foreground leading-tight">
                    {opt.emoji} {opt.title}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground leading-snug">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          <Field label={s.vendor_your_name} value={name} onChange={setName} placeholder={s.vendor_name_placeholder} required />
          {vendorType === "shop" && (
            <Field
              label={s.vendor_shop_name}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_shop_placeholder}
              required
              error={shopName.length > 0 && !shopOk ? s.vendor_specify_hint : undefined}
            />
          )}
          {vendorType === "home" && (
            <Field
              label={s.vendor_brand_name_optional}
              value={shopName}
              onChange={setShopName}
              placeholder={s.vendor_brand_placeholder}
              error={homeShopInvalid ? s.vendor_specify_hint : undefined}
            />
          )}

          <div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.vendor_categories_label}
              </label>
              <span className="text-xs text-muted-foreground">
                {s.vendor_categories_selected(selectedCategoryIds.length)}
              </span>
            </div>

            <Textarea
              value={businessDescription}
              onChange={(e) => setBusinessDescription(e.target.value)}
              placeholder={s.category_describe_placeholder}
              className="mt-2 min-h-[72px] resize-none"
            />
            <button
              type="button"
              onClick={() => void handleFindCategory()}
              disabled={categorySuggesting || businessDescription.trim().length < 3}
              className="mt-2 w-full rounded-xl bg-brand px-3 py-2.5 text-sm font-semibold text-brand-foreground disabled:opacity-50 inline-flex items-center justify-center gap-2"
            >
              {categorySuggesting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {s.category_finding}
                </>
              ) : (
                s.category_findButton
              )}
            </button>

            {categorySuggestion?.outcome === "high_existing" &&
              categorySuggestion.category_id && (
                <div className="mt-3 rounded-2xl border border-brand/40 bg-brand/10 p-3 space-y-2">
                  <p className="text-sm font-semibold text-foreground">
                    {s.category_suggestion(categorySuggestion.category_name ?? "")}
                  </p>
                  {categorySuggestion.reasoning && (
                    <p className="text-xs text-muted-foreground">{categorySuggestion.reasoning}</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        selectCategoryFromSuggestion(
                          categorySuggestion.category_id!,
                          categorySuggestion.category_name ?? "",
                          categorySuggestion.emoji,
                          categorySuggestion.service_mode ?? "help",
                        )
                      }
                      className="flex-1 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                    >
                      {s.category_confirm}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCategorySuggestion(null);
                        setShowManualCategories(true);
                      }}
                      className="flex-1 rounded-xl border border-border px-3 py-2 text-xs font-semibold"
                    >
                      {s.category_chooseDifferently}
                    </button>
                  </div>
                </div>
              )}

            {categorySuggestion?.outcome === "medium_existing" &&
              categorySuggestion.category_id && (
                <div className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
                  <p className="text-sm font-semibold text-foreground">
                    {s.category_didYouMean(categorySuggestion.category_name ?? "")}
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        selectCategoryFromSuggestion(
                          categorySuggestion.category_id!,
                          categorySuggestion.category_name ?? "",
                          categorySuggestion.emoji,
                          categorySuggestion.service_mode ?? "help",
                        )
                      }
                      className="flex-1 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                    >
                      {s.category_yes}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCategorySuggestion(null);
                        setShowManualCategories(true);
                      }}
                      className="flex-1 rounded-xl border border-border px-3 py-2 text-xs font-semibold"
                    >
                      {s.category_no}
                    </button>
                  </div>
                </div>
              )}

            {(categorySuggestion?.outcome === "new_suggested" ||
              categorySuggestion?.outcome === "medium_new") && (
              <div className="mt-3 rounded-2xl border border-border bg-muted/40 p-3 space-y-2">
                <p className="text-sm font-semibold text-foreground">
                  {s.category_suggest_new(categorySuggestion.category_name ?? "")}
                </p>
                {categorySuggestion.reasoning && (
                  <p className="text-xs text-muted-foreground">{categorySuggestion.reasoning}</p>
                )}
                <button
                  type="button"
                  onClick={confirmNewCategorySuggestion}
                  className="w-full rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-brand-foreground"
                >
                  {s.category_confirm}
                </button>
              </div>
            )}

            {categorySuggestion?.outcome === "low_confidence" && (
              <div className="mt-3 space-y-2">
                <p className="text-xs text-muted-foreground">{s.category_notSure}</p>
                <div className="flex flex-wrap gap-2">
                  {(categorySuggestion.top_picks ?? []).map((pick) => (
                    <button
                      key={pick.id}
                      type="button"
                      onClick={() =>
                        selectCategoryFromSuggestion(
                          pick.id,
                          pick.label,
                          pick.emoji,
                          pick.service_mode,
                        )
                      }
                      className="rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium"
                    >
                      {pick.emoji} {getLabel(pick.label)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {pendingNewCategoryCreate && (
              <p className="mt-2 text-xs font-medium text-brand">
                {s.category_suggest_new(pendingNewCategoryCreate.category_name)}
              </p>
            )}

            <button
              type="button"
              onClick={() => setShowManualCategories((v) => !v)}
              className="mt-3 text-xs font-medium text-muted-foreground hover:text-foreground underline"
            >
              {s.category_browseManual}
            </button>

            {showManualCategories && (
              <>
                {regCategoriesLoading ? (
                  <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {s.vendor_understanding}
                  </p>
                ) : allRegCategories.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {allRegCategories.map((cat) => {
                      const selected = selectedCategoryIds.includes(cat.id);
                      const atMax = selectedCategoryIds.length >= MAX_REG_CATEGORIES;
                      const disabled = !selected && atMax;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => toggleRegCategory(cat.id)}
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
              </>
            )}

            {selectedCategoryIds.length === 0 && !pendingNewCategoryCreate && (
              <p className="mt-2 text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
            )}
          </div>

          <Field
            label={s.vendor_phone_label}
            value={phone}
            onChange={setPhone}
            placeholder={s.vendor_phone_placeholder}
            required
            error={phone.length > 0 && !phoneOk ? s.vendor_phone_hint : undefined}
          />
          <Field
            label={s.vendor_upi_label}
            value={upi}
            onChange={setUpi}
            onBlur={() => setUpiBlurred(true)}
            placeholder={s.vendor_upi_placeholder}
            required
            error={upiFormatError}
          />

          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {s.vendor_note_label}
            </label>
            <textarea
              value={vendorNote}
              onChange={(e) => setVendorNote(e.target.value.slice(0, 100))}
              rows={2}
              placeholder={s.vendor_note_placeholder}
              className="mt-1 w-full bg-card border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
            <p className="text-[10px] text-muted-foreground text-right mt-0.5">
              {vendorNote.length}/100
            </p>
          </div>

          {referralEnabled && (
            <div className="space-y-1">
              <label className="text-xs text-gray-400">{s.vendor_referralCodeLabel}</label>
              <input
                type="text"
                value={referralCodeInput}
                onChange={(e) => setReferralCodeInput(e.target.value.toUpperCase().trim())}
                placeholder={s.vendor_referralCodePlaceholder}
                maxLength={10}
                className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand/50"
              />
            </div>
          )}

          {vendorType !== "" && vendorType !== "visiting" && (
            <>
              <p className="text-[11px] text-amber-400/90 text-center px-2">
                ⚠️ {s.vendor_gps_warning}
              </p>
              <button
                type="button"
                onClick={() => void detectLocation()}
                className={`w-full rounded-xl border-2 py-3.5 flex items-center justify-center gap-2 font-semibold transition-colors ${
                  coords ? "border-secondary text-secondary bg-secondary/5" : "border-border text-foreground"
                }`}
              >
                {locating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
                {coords
                  ? `${s.vendor_location_set} (${coords.lat.toFixed(3)}, ${coords.lng.toFixed(3)})`
                  : s.vendor_capture_location}
              </button>
            </>
          )}
          {vendorType === "visiting" && (
            <p className="text-[11px] text-muted-foreground text-center px-2 inline-flex items-center justify-center gap-1.5 w-full">
              {locating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
                  {s.vendor_visiting_location_hint}
                </>
              ) : coords ? (
                s.vendor_visiting_location_ready
              ) : (
                s.vendor_visiting_location_hint
              )}
            </p>
          )}

          <button
            disabled={!canRegister}
            className="w-full mt-2 rounded-2xl bg-primary text-primary-foreground py-4 font-semibold shadow-card active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
            {s.vendor_register_btn}
          </button>
          {!phoneOk && (
            <p className="text-xs text-muted-foreground text-center">
              {s.vendor_register_hint}
            </p>
          )}
          </form>

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
                    {s.vendor_type_label}
                  </label>
                  <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                    {(
                      [
                        {
                          value: "shop" as const,
                          emoji: "🏪",
                          title: s.vendor_type_shop,
                          desc: s.vendor_type_shop_desc,
                        },
                        {
                          value: "home" as const,
                          emoji: "🏠",
                          title: s.vendor_type_home,
                          desc: s.vendor_type_home_desc,
                        },
                        {
                          value: "visiting" as const,
                          emoji: "🚗",
                          title: s.vendor_type_visiting,
                          desc: s.vendor_type_visiting_desc,
                        },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setEditVendorType(opt.value)}
                        className={cn(
                          "rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                          "bg-surface border-surface-border",
                          editVendorType === opt.value &&
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

                {editVendorType === "shop" && (
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
                {editVendorType === "home" && (
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
