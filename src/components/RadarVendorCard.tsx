import { useCallback, useEffect, useState } from "react";
import {
  MapPin,
  Phone,
  Store,
  Clock,
  HeartHandshake,
  Package,
  Loader2,
} from "lucide-react";
import { supabase, type Vendor, useCategoryLabel } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, migrateUserPhone } from "@/lib/userIdentity";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { ParchiSheet } from "@/components/ParchiSheet";
import { AiBridgeSheet } from "@/components/AiBridgeSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TrustBadge } from "@/components/TrustBadge";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";
import { deriveBusinessLocationPasses } from "@/lib/trustLevel";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
import {
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
import { markNeighboursDirty } from "@/lib/savedVendors";

export { markNeighboursDirty, consumeNeighboursDirty } from "@/lib/savedVendors";
import type { TrustLevel } from "@/lib/trustLevel";
import {
  resolveCategoryBrandName,
  resolveCategoryReach,
  formatRadarReachLabels,
} from "@/lib/categoryScopedVendor";

const RESOLUTION_SESSION_PREFIX = "aaspaas:resolution:";
const VENDOR_SELF_STORAGE_KEY = "aaspaas:vendor_id";

function readResolutionMarked(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${RESOLUTION_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

function writeResolutionMarked(vendorId: string) {
  try {
    sessionStorage.setItem(`${RESOLUTION_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore quota / private mode */
  }
}

const SAVED_SESSION_PREFIX = "aaspaas:saved:";
const MAX_SAVED_NEIGHBOURS = 20;

export function readSessionSaved(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${SAVED_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

function writeSessionSaved(vendorId: string) {
  try {
    sessionStorage.setItem(`${SAVED_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore */
  }
}

function clearSessionSaved(vendorId: string) {
  try {
    sessionStorage.removeItem(`${SAVED_SESSION_PREFIX}${vendorId}`);
  } catch {
    /* ignore */
  }
}

async function countSavedNeighbours(): Promise<number> {
  // Direct saved_vendors reads return zero rows for OTP-off callers
  // (auth_user_phone() NULL in RLS); count via the identity RPC instead.
  const { data, error } = await supabase.rpc("get_saved_vendors_count", {
    p_user_phone: getUserPhone(),
    p_device_id: getDeviceId(),
  });
  if (error) return 0;
  return typeof data === "number" ? data : 0;
}

function readIsOwnVendorCard(vendorId: string, vendorPhone: string | null | undefined): boolean {
  try {
    const mine = localStorage.getItem(VENDOR_SELF_STORAGE_KEY);
    if (mine == null || mine !== vendorId) return false;
    const userPhone = localStorage.getItem("aaspaas:user_phone");
    if (!userPhone?.trim() || !vendorPhone?.trim()) return false;
    const digits = (p: string) => {
      const cleaned = p.replace(/\D/g, "");
      return cleaned.length === 12 && cleaned.startsWith("91") ? cleaned.slice(2) : cleaned;
    };
    return digits(userPhone) === digits(vendorPhone);
  } catch {
    return false;
  }
}

/** Subtle reputation line: below trust badge area, above Connect CTA. */
const VendorReputationLine = ({
  vendor,
  totalHelpedOverride,
  totalDeliveredOverride,
}: {
  vendor: Vendor;
  totalHelpedOverride?: number;
  totalDeliveredOverride?: number;
}) => {
  const { s } = useLanguage();
  const mode = String(vendor.service_mode ?? "")
    .trim()
    .toLowerCase();

  if (mode === "help" || mode === "appointment") {
    const n = totalHelpedOverride ?? vendor.total_helped ?? 0;
    if (n <= 0) return null;
    return (
      <div
        className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90"
        data-testid="radar-reputation-helped"
        data-count={n}
      >
        <span className="inline-flex items-center gap-1 shrink-0">
          <HeartHandshake className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">{s.radar_stat_helped}</span>
        </span>
        <span>
          {s.radar_helped}
          <span className="font-semibold tabular-nums text-brand">{n}</span>{" "}
          {n === 1 ? s.radar_person : s.radar_people}
        </span>
      </div>
    );
  }

  if (mode === "delivery") {
    const d = totalDeliveredOverride ?? vendor.total_delivered ?? 0;
    if (d <= 0) return null;
    const raw = vendor.on_time_rate;
    const pct = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
    return (
      <div
        className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90"
        data-testid="radar-reputation-delivered"
        data-count={d}
        data-on-time={pct ?? undefined}
      >
        <span className="inline-flex items-center gap-1 shrink-0">
          <Package className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">{s.radar_stat_delivered}</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums text-brand">{d}</span>
          {s.radar_orders_served}
          {pct !== null && d > 0 && (
            <>
              {" "}
              · <span className="font-semibold tabular-nums text-brand">{pct}</span>
              {s.radar_on_time}
            </>
          )}
        </span>
      </div>
    );
  }

  return null;
};

const VendorCategoryChips = ({
  categories,
  fallbackLabel,
  getLabel,
}: {
  categories: { label: string; emoji: string; category_id?: string }[];
  fallbackLabel: string;
  getLabel: (label: string) => string;
}) => {
  const chips =
    categories.length > 0
      ? categories
      : fallbackLabel
        ? [{ label: fallbackLabel, emoji: "✨" }]
        : [];

  if (chips.length === 0) return null;

  const scrollable = chips.length > 1;

  return (
    <div
      className={cn(
        "mt-1.5 flex gap-1.5 min-w-0",
        scrollable ? "overflow-x-auto pb-0.5 -mx-0.5 px-0.5 scrollbar-none" : "flex-wrap",
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
};

const CategoryReachLabel = ({
  reach,
  dist,
}: {
  reach: { serves_at_vendor_place: boolean; serves_at_customer_place: boolean };
  dist: number | null;
}) => {
  const { s } = useLanguage();
  const labels = formatRadarReachLabels(reach, dist, {
    comesToYou: s.radar_reach_comes_to_you,
    visitThemKm: s.radar_reach_visit_them_km,
    visitThemMtr: s.radar_reach_visit_them_mtr,
  });
  if (labels.length === 0) return null;
  return (
    <p className="text-[11px] text-muted-foreground mt-0.5" data-testid="radar-reach-label">
      {labels.join(" · ")}
    </p>
  );
};

type Props = {
  vendor: Vendor;
  isSaved: boolean;
  hasOrdered: boolean;
  /** Batch-fetched by the parent so the card renders complete on first paint. */
  hasFulfilledOrder: boolean;
  /** Fulfilled request id for this customer+vendor pair (batch-fetched by parent). */
  fulfilledRequestId?: string | null;
  /** Menu preview (first 5 available items), batch-fetched by the parent. */
  menuItems: { name: string; price: number; unit: string | null; is_available: boolean; image_url?: string | null }[];
  categories: {
    label: string;
    emoji: string;
    category_id?: string;
    brand_name?: string | null;
    serves_at_vendor_place?: boolean | null;
    serves_at_customer_place?: boolean | null;
    service_radius_km?: number | null;
    is_manual_verified?: boolean | null;
    shop_photo_url?: string | null;
    verification_status?: string | null;
  }[];
  trustLevel?: TrustLevel;
  dist: number | null;
  index: number;
  userNeed: string;
  /** Optional; clears card UI when an order/booking is cancelled from the sheet path. */
  onOrderCancelled?: () => void;
  /** Pan-India service area — inline badge below shop name. */
  showPanIndiaBadge?: boolean;
  /** Radar tab mode used to find this vendor (may differ from vendors.service_mode). */
  radarServiceMode?: string;
  /** Pre-resolved display brand from parent (matched category). */
  displayBrandName?: string;
};

export function RadarVendorCard({
  vendor,
  isSaved,
  hasOrdered,
  hasFulfilledOrder,
  fulfilledRequestId = null,
  menuItems,
  categories,
  trustLevel,
  dist,
  index,
  userNeed,
  onOrderCancelled = () => {},
  showPanIndiaBadge = false,
  radarServiceMode,
  displayBrandName,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const serviceMode = String(radarServiceMode ?? vendor.service_mode ?? "")
    .trim()
    .toLowerCase();
  const isOwnVendor = readIsOwnVendorCard(vendor.id, vendor.phone);
  const matchedCategoryId = categories[0]?.category_id ?? null;
  const brandName =
    displayBrandName?.trim() ||
    resolveCategoryBrandName(
      categories[0]?.brand_name,
      vendor.shop_name,
      matchedCategoryId,
    ) ||
    vendor.shop_name;
  const categoryReach = resolveCategoryReach(
    categories[0],
    {
      serves_at_vendor_place: vendor.serves_at_vendor_place,
      serves_at_customer_place: vendor.serves_at_customer_place,
    },
    matchedCategoryId,
  );
  const businessTrust = categories[0]
    ? {
        is_manual_verified: categories[0].is_manual_verified,
        shop_photo_url: categories[0].shop_photo_url,
        verification_status: categories[0].verification_status,
      }
    : {
        is_manual_verified: vendor.is_manual_verified,
        shop_photo_url: vendor.shop_photo_url,
        verification_status: vendor.verification_status,
      };
  
  // Compute business-specific GPS verification for the matched category
  const businessLocationData = categories[0] && 'gps_match_distance' in categories[0] ? {
    vendor_id: vendor.id,
    category_id: categories[0].category_id,
    shop_photo_url: (categories[0] as any).shop_photo_url,
    gps_match_distance: (categories[0] as any).gps_match_distance,
    location_accuracy: (categories[0] as any).location_accuracy,
    photo_accuracy: (categories[0] as any).photo_accuracy,
    verification_status: (categories[0] as any).verification_status,
  } : null;
  
  const { gps: businessGpsVerified } = deriveBusinessLocationPasses(businessLocationData);

  const [helpCount, setHelpCount] = useState(() => vendor.total_helped ?? 0);
  const [deliveredCount, setDeliveredCount] = useState(() => vendor.total_delivered ?? 0);
  const [resolutionMarked, setResolutionMarked] = useState(() => readResolutionMarked(vendor.id));
  const [resolutionBusy, setResolutionBusy] = useState(false);

  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  const [parchiOpen, setParchiOpen] = useState(false);
  const [parchiVendor, setParchiVendor] = useState(vendor);
  const [openingParchi, setOpeningParchi] = useState(false);
  const [savedVendorLocked, setSavedVendorLocked] = useState(() =>
    isSaved || readSessionSaved(vendor.id),
  );
  const [resolutionSessionTick, setResolutionSessionTick] = useState(0);
  const [deliveryActiveFromDb, setDeliveryActiveFromDb] = useState(false);
  const [serviceFulfilledFromDb, setServiceFulfilledFromDb] = useState(hasFulfilledOrder);
  const [serviceFulfilledRequestId, setServiceFulfilledRequestId] = useState<string | null>(
    fulfilledRequestId,
  );
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);
  const [saveNicknameSheetOpen, setSaveNicknameSheetOpen] = useState(false);
  const [saveNicknameDraft, setSaveNicknameDraft] = useState("");
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateCardLoading, setRateCardLoading] = useState(false);
  const [rateCardItems, setRateCardItems] = useState<
    { name: string; price: number; unit: string | null; image_url?: string | null }[]
  >([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const openRateCard = useCallback(async () => {
    setRateCardOpen(true);
    if (rateCardItems.length > 0 || rateCardLoading) return;
    setRateCardLoading(true);
    const matchedCategoryId = categories[0]?.category_id ?? null;
    let q = supabase
      .from("vendor_menu_items")
      .select("name, price, unit, category_id, image_url")
      .eq("vendor_id", vendor.id)
      .eq("is_available", true)
      .order("sort_order", { ascending: true });
    if (matchedCategoryId) {
      q = q.eq("category_id", matchedCategoryId);
    }
    const { data } = await q;
    setRateCardItems(data ?? []);
    setRateCardLoading(false);
  }, [rateCardItems.length, rateCardLoading, vendor.id, categories]);

  useEffect(() => {
    setHelpCount(vendor.total_helped ?? 0);
    setDeliveredCount(vendor.total_delivered ?? 0);
    setResolutionMarked(readResolutionMarked(vendor.id));
    setSavedVendorLocked(isSaved || readSessionSaved(vendor.id));
    setServiceFulfilledFromDb(hasFulfilledOrder);
    setServiceFulfilledRequestId(fulfilledRequestId);
    setParchiVendor(vendor);
  }, [
    vendor,
    vendor.id,
    vendor.total_delivered,
    vendor.total_helped,
    isSaved,
    hasFulfilledOrder,
    fulfilledRequestId,
  ]);

  const refreshActiveOrderFromDb = useCallback(async () => {
    if ((serviceMode !== "delivery" && serviceMode !== "appointment") || isOwnVendor) {
      setDeliveryActiveFromDb(false);
      return;
    }
    // Identity RPC: direct requests reads are RLS-blocked for OTP-off callers.
    // Returned rows are sent/seen by definition, so presence = active.
    const { data } = await supabase.rpc("get_my_active_request_vendor_ids", {
      p_user_phone: getUserPhone(),
      p_device_id: getDeviceId(),
      p_vendor_ids: [vendor.id],
    });
    setDeliveryActiveFromDb(!!data?.length);
  }, [vendor.id, serviceMode, isOwnVendor]);

  const handleOrderCancelled = useCallback(() => {
    setDeliveryActiveFromDb(false);
    onOrderCancelled();
  }, [onOrderCancelled]);

  const refreshServiceFulfilledFromDb = useCallback(async () => {
    if (isOwnVendor) {
      setServiceFulfilledFromDb(false);
      setServiceFulfilledRequestId(null);
      return;
    }
    const { data } = await supabase.rpc("get_my_fulfilled_request_ids", {
      p_user_phone: getUserPhone(),
      p_device_id: getDeviceId(),
      p_vendor_ids: [vendor.id],
    });
    const row = (data as { id: string; vendor_id: string }[] | null)?.[0];
    setServiceFulfilledFromDb(!!row);
    setServiceFulfilledRequestId(row?.id ?? null);
  }, [vendor.id, isOwnVendor]);

  const refreshSavedNeighbourFromDb = useCallback(async () => {
    if (isOwnVendor) return;
    // get_saved_vendors mirrors the old scoping (phone when present, else
    // device); check membership for this card's vendor client-side.
    const { data: savedRows } = await supabase.rpc("get_saved_vendors", {
      p_user_phone: getUserPhone(),
      p_device_id: getDeviceId(),
    });
    const data = ((savedRows ?? []) as { vendor_id: string }[]).filter(
      (r) => r.vendor_id === vendor.id,
    );
    if (data?.length) {
      writeSessionSaved(vendor.id);
      setSavedVendorLocked(true);
    } else {
      clearSessionSaved(vendor.id);
      setSavedVendorLocked(false);
    }
  }, [vendor.id, isOwnVendor]);

  const refreshOnVisibility = useCallback(async () => {
    await Promise.all([
      refreshActiveOrderFromDb(),
      refreshServiceFulfilledFromDb(),
      refreshSavedNeighbourFromDb(),
    ]);
  }, [refreshActiveOrderFromDb, refreshServiceFulfilledFromDb, refreshSavedNeighbourFromDb]);

  // Initial order/fulfilled/saved state is batch-fetched by the parent before
  // the card renders; only refetch after an in-card interaction (tick) or on
  // visibility change, so the card never visibly mutates right after mount.
  useEffect(() => {
    if (resolutionSessionTick === 0) return;
    void refreshActiveOrderFromDb();
  }, [refreshActiveOrderFromDb, resolutionSessionTick]);

  useEffect(() => {
    if (resolutionSessionTick === 0) return;
    void refreshServiceFulfilledFromDb();
  }, [refreshServiceFulfilledFromDb, resolutionSessionTick]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void refreshOnVisibility();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refreshOnVisibility]);

  useEffect(() => {
    if (!serviceFulfilledRequestId) return;
    void (async () => {
      const { data } = await supabase
        .from("vendor_reviews")
        .select("id")
        .eq("request_id", serviceFulfilledRequestId)
        .maybeSingle();
      if (data) {
        writeResolutionMarked(vendor.id);
        setResolutionMarked(true);
      }
    })();
  }, [serviceFulfilledRequestId, vendor.id]);

  const showResolution = !isOwnVendor && serviceFulfilledFromDb;

  const showSendOrderSection =
    !isOwnVendor &&
    (serviceMode === "delivery" || serviceMode === "appointment" || serviceMode === "help");

  const deliveryOrderSent = hasOrdered || deliveryActiveFromDb;

  const showConnectAiBridge =
    serviceMode === "help" || deliveryOrderSent;

  const isNeighbourSaved = !isOwnVendor && (isSaved || savedVendorLocked);
  const showSaveRow = !isOwnVendor && !isNeighbourSaved;
  const showUnsaveRow = isNeighbourSaved;

  const accentRing =
    vendorBinaryTrustTier({
      is_manual_verified: businessTrust.is_manual_verified,
      upi_verified: vendor.upi_verified,
      photo_selfie: vendor.photo_selfie,
      businessGpsVerified: businessGpsVerified,
      // Keep latitude for backward compatibility (will use businessGpsVerified if present)
      latitude: vendor.latitude,
    }) === "green"
      ? "ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
      : "ring-destructive/30";

  const handleConnect = useCallback(async () => {
    const { data } = await supabase
      .from("vendors")
      .select("is_active")
      .eq("id", vendor.id)
      .single();
    if (!data?.is_active) {
      toast.error(s.radar_vendorWentOffline);
      return;
    }
    setAiSheetOpen(true);
  }, [vendor, s.radar_vendorWentOffline]);

  const beginSaveVendor = useCallback(() => {
    if (savedVendorLocked || isSaved) return;
    const userPhone = getUserPhone();
    if (userPhone === null) {
      setPhoneSheetOpen(true);
      return;
    }
    setSaveNicknameDraft("");
    setSaveNicknameSheetOpen(true);
  }, [savedVendorLocked, isSaved]);

  const handleSaveVendor = useCallback(async (nicknameInput = "") => {
    if (savedVendorLocked || isSaved) return;
    const userPhone = getUserPhone();
    if (userPhone === null) {
      setPhoneSheetOpen(true);
      return;
    }
    const existing = await countSavedNeighbours();
    if (existing >= MAX_SAVED_NEIGHBOURS) {
      toast.error(s.neighbours_max_reached);
      return;
    }
    const device_id = getDeviceId();
    const nickname = nicknameInput.trim();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("save_saved_vendor", {
              p_vendor_id: vendor.id,
              p_category: vendor.category,
              p_nickname: nickname,
              p_device_id: device_id,
              p_user_phone: userPhone,
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
      if (error) {
        if (error.code === "23505") {
          writeSessionSaved(vendor.id);
          setSavedVendorLocked(true);
          setSaveNicknameSheetOpen(false);
          markNeighboursDirty();
          toast.success(`✅ ${s.radar_saved_success}`);
          return;
        }
        const msg = String(error.message ?? "");
        if (msg.includes("saved_vendors_limit_exceeded")) {
          toast.error(s.neighbours_max_reached);
          return;
        }
        captureError(error, {
          scope: "radarVendorCard.saveSavedVendor",
          vendorId: vendor.id,
        });
        toast.error(s.radar_could_not_save, { description: error.message });
        return;
      }
      writeSessionSaved(vendor.id);
      setSavedVendorLocked(true);
      setSaveNicknameSheetOpen(false);
      markNeighboursDirty();
      toast.success(`✅ ${s.radar_saved_success}`);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        captureError(err, {
          scope: "radarVendorCard.saveSavedVendor",
          vendorId: vendor.id,
        });
        showNetworkFailedToast(() => void handleSaveVendor(nicknameInput), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  }, [isSaved, savedVendorLocked, vendor, s]);

  const handleUnsaveVendor = useCallback(async () => {
    if (!savedVendorLocked && !isSaved) return;
    const device_id = getDeviceId();
    const userPhone = getUserPhone();
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc("unsave_saved_vendor", {
              p_vendor_id: vendor.id,
              p_device_id: device_id,
              p_user_phone: userPhone ?? null,
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
      if (error) {
        captureError(error, {
          scope: "radarVendorCard.unsaveSavedVendor",
          vendorId: vendor.id,
        });
        toast.error(s.couldNotRemove, { description: error.message });
        return;
      }
      clearSessionSaved(vendor.id);
      setSavedVendorLocked(false);
      markNeighboursDirty();
      toast.success(s.neighbours_removed);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        captureError(err, {
          scope: "radarVendorCard.unsaveSavedVendor",
          vendorId: vendor.id,
        });
        showNetworkFailedToast(() => void handleUnsaveVendor(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    }
  }, [isSaved, savedVendorLocked, vendor.id, s]);

  const handleResolution = useCallback(async () => {
    if (resolutionMarked || resolutionBusy) return;

    const requestId = serviceFulfilledRequestId;
    if (requestId) {
      const { data: existingReview } = await supabase
        .from("vendor_reviews")
        .select("id")
        .eq("request_id", requestId)
        .maybeSingle();
      if (existingReview) {
        writeResolutionMarked(vendor.id);
        setResolutionMarked(true);
        return;
      }
    }

    const isDelivery = serviceMode === "delivery";
    const rpc = isDelivery ? "increment_vendor_delivered" : "increment_vendor_helped";
    setResolutionBusy(true);
    try {
      const { error } = await withNetworkRetry(
        async () =>
          throwOnSupabaseNetworkError(
            await supabase.rpc(rpc, { p_vendor_id: vendor.id }),
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
        captureError(error, {
          scope: "radarVendorCard.resolution",
          vendorId: vendor.id,
          rpc,
        });
        toast.error(s.radar_could_not_save, { description: error.message });
        return;
      }
      writeResolutionMarked(vendor.id);
      setResolutionMarked(true);
      if (isDelivery) setDeliveredCount((c) => c + 1);
      else setHelpCount((c) => c + 1);
      toast.success(s.radar_thank_community);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        captureError(err, {
          scope: "radarVendorCard.resolution",
          vendorId: vendor.id,
        });
        showNetworkFailedToast(() => void handleResolution(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setResolutionBusy(false);
    }
  }, [
    resolutionMarked,
    resolutionBusy,
    serviceMode,
    serviceFulfilledRequestId,
    vendor.id,
    s,
  ]);

  const openParchi = useCallback(async () => {
    const needsRefetch =
      serviceMode === "help" ||
      ((serviceMode === "delivery" || serviceMode === "appointment") &&
        vendor.is_active === false);

    if (needsRefetch) {
      setOpeningParchi(true);
      const { data } = await supabase
        .from("vendors")
        .select("*")
        .eq("id", vendor.id)
        .single();
      setOpeningParchi(false);

      if (serviceMode === "help") {
        if (!data?.is_active) {
          toast.error(s.radar_vendorWentOffline);
          return;
        }
        setParchiVendor({ ...vendor, ...data, is_active: data.is_active });
      } else if (data) {
        setParchiVendor({ ...vendor, ...data, is_active: data.is_active });
      }
    } else {
      setParchiVendor(vendor);
    }

    setParchiOpen(true);
  }, [vendor, serviceMode, s.radar_vendorWentOffline]);

  const serviceModePill =
    serviceMode === "delivery"
      ? s.radar_pill_delivery
      : serviceMode === "appointment"
        ? s.radar_pill_appointment
        : s.radar_pill_help;

  return (
    <>
    <div
      data-testid="radar-vendor-card"
      className={cn(
        "relative mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 animate-fade-up",
        accentRing,
      )}
      style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
    >
      {openingParchi && (
        <div
          className="absolute inset-0 z-10 rounded-2xl bg-background/60 grid place-items-center"
          aria-busy="true"
          aria-label={s.settings_loading}
        >
          <Loader2 className="h-6 w-6 animate-spin text-brand" />
        </div>
      )}
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-gradient-vendor grid place-items-center shrink-0 overflow-hidden">
          {businessTrust.shop_photo_url || vendor.shop_photo_url ? (
            <img
              src={(businessTrust.shop_photo_url || vendor.shop_photo_url)!}
              alt={`${brandName} shop`}
              className="h-full w-full object-cover cursor-pointer"
              loading="lazy"
              onClick={() => {
                setLightboxUrl(businessTrust.shop_photo_url || vendor.shop_photo_url);
                setLightboxOpen(true);
              }}
            />
          ) : (
            <Store className="h-6 w-6 text-primary-foreground" aria-hidden />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-1.5 min-w-0">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-foreground break-words leading-snug inline-flex items-center gap-1.5 flex-wrap">
                <span>{brandName}</span>
                {vendor.is_active === true && (
                  <span
                    className="h-2 w-2 rounded-full bg-brand shrink-0"
                    aria-label={s.radar_vendor_online_aria}
                  />
                )}
                {vendor.is_active === false && (
                  <span className="inline-flex text-[10px] rounded-full px-2 py-0.5 bg-amber-500/20 text-amber-600 font-medium shrink-0">
                    {s.vendor_offline_badge}
                  </span>
                )}
              </h3>
              {readIsOwnVendorCard(vendor.id, vendor.phone) && (
                <span className="text-[10px] font-medium text-muted-foreground">
                  {s.radar_own_vendor_label}
                </span>
              )}
            </div>
            <span className="inline-flex items-center gap-1 shrink-0 flex-wrap justify-end">
              <TrustBadge
                vendorId={vendor.id}
                categoryId={matchedCategoryId}
                isManualVerified={businessTrust.is_manual_verified}
                trustLevel={trustLevel}
                showLabel
              />
            </span>
          </div>
          <CategoryReachLabel reach={categoryReach} dist={dist} />
          {showPanIndiaBadge && (
            <span className="mt-1 inline-flex text-[10px] rounded-full px-2 py-0.5 bg-brand/20 text-brand font-medium w-fit">
              {s.radar_pan_india_badge}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-1.5 mt-1 min-w-0">
            <div className="min-w-0 flex-1">
              <VendorCategoryChips
                categories={categories}
                fallbackLabel={vendor.category}
                getLabel={getLabel}
              />
            </div>
            <span className="text-xs rounded-full px-2 py-0.5 bg-brand/20 text-brand font-medium shrink-0">
              {serviceModePill}
            </span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
            {dist != null ? (
              <span className="text-xs bg-surface-border rounded-full px-2 py-0.5 inline-flex items-center gap-1 text-muted-foreground">
                <MapPin className="h-3 w-3" />
                {dist < 1
                  ? s.radar_distance_mtr.replace("{value}", String(Math.round(dist * 1000)))
                  : s.radar_distance_km.replace("{value}", dist.toFixed(1))}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{s.radar_location_unknown}</span>
            )}
            {vendor.avg_rating && vendor.review_count ? (
              <span className="text-xs">
                <span className="text-brand font-bold">⭐ {vendor.avg_rating.toFixed(1)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  ({vendor.review_count} {s.review_reviews})
                </span>
              </span>
            ) : null}
          </div>
          {serviceMode === "help" && dist != null && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-brand-muted ring-1 ring-brand/30 px-2 py-0.5 text-[11px] font-semibold text-green-700 dark:text-brand">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{s.radar_eta_label}</span>
              </span>
              {s.radar_eta_minutes.replace(
                "{minutes}",
                String(Math.max(1, Math.round(dist * 2))),
              )}
            </div>
          )}
        </div>
      </div>

      <TrustWarningBanner
        tier={vendorBinaryTrustTier({
          is_manual_verified: businessTrust.is_manual_verified,
          upi_verified: vendor.upi_verified,
          photo_selfie: vendor.photo_selfie,
          businessGpsVerified: businessGpsVerified,
          // Keep latitude for backward compatibility (will use businessGpsVerified if present)
          latitude: vendor.latitude,
        })}
        context="radar"
      />

      <VendorReputationLine
        vendor={vendor}
        totalHelpedOverride={helpCount}
        totalDeliveredOverride={deliveredCount}
      />

      {menuItems.length > 0 && (
        <div className="mt-3 pt-3 border-t border-surface-border space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {s.menu_preview}
          </p>
          {menuItems.slice(0, 3).map((item, i) => (
            <div key={i} className="flex justify-between items-center gap-2">
              {item.image_url ? (
                <img
                  src={item.image_url}
                  alt=""
                  className="h-9 w-9 rounded-md object-cover shrink-0 border border-surface-border"
                />
              ) : null}
              <span className="text-foreground text-sm flex-1 truncate">{item.name}</span>
              <span className="text-sm shrink-0 text-muted-foreground">
                ₹{item.price}
                {item.unit ? `/${item.unit}` : ""}
              </span>
            </div>
          ))}
          {(serviceMode === "appointment" || serviceMode === "delivery") && menuItems.length > 3 && (
            <button
              type="button"
              onClick={() => void openRateCard()}
              className="text-[11px] text-muted-foreground hover:text-foreground text-left pt-1"
            >
              {serviceMode === "delivery" ? s.radar_viewFullMenu : s.radar_viewFullRateCard}
            </button>
          )}
          {menuItems.length > 3 && (
            <p className="text-[10px] text-muted-foreground">
              +{menuItems.length - 3} {s.menu_moreItems}
            </p>
          )}
        </div>
      )}

      <Sheet open={rateCardOpen} onOpenChange={setRateCardOpen}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[80vh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>
              {serviceMode === "delivery"
                ? `${s.radar_menuLabel} — ${brandName}`
                : `${s.radar_rateCardLabel} — ${brandName}`}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {rateCardLoading ? (
              <p className="text-sm text-muted-foreground">{s.settings_loading}</p>
            ) : (
              <div className="rounded-xl border border-border overflow-hidden">
                {rateCardItems.map((item, idx) => (
                  <div
                    key={`${item.name}-${idx}`}
                    className={cn(
                      "flex items-center justify-between gap-2 px-3 py-2 text-sm",
                      idx !== 0 && "border-t border-border",
                    )}
                  >
                    {item.image_url ? (
                      <img
                        src={item.image_url}
                        alt=""
                        className="h-10 w-10 rounded-md object-cover shrink-0 border border-border"
                      />
                    ) : null}
                    <span className="text-foreground flex-1 min-w-0">{item.name}</span>
                    <span className="text-brand font-semibold tabular-nums shrink-0">
                      ₹{item.price}
                      {item.unit ? `/${item.unit}` : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {vendor.vendor_note && (
            <div className="mt-4 text-xs text-muted-foreground">
              <span className="font-semibold">{s.radar_aboutLabel}</span>
              <span className="text-muted-foreground"> · </span>
              <span>{vendor.vendor_note}</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setRateCardOpen(false);
              void openParchi();
            }}
            className="mt-5 w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform"
          >
            {serviceMode === "appointment"
              ? s.radar_cta_book
              : serviceMode === "delivery"
                ? s.radar_cta_order
                : s.radar_cta_connect}
          </button>
        </SheetContent>
      </Sheet>

      {showConnectAiBridge && (
          <button
            type="button"
            onClick={() => void handleConnect()}
            className="mt-3 w-full rounded-xl bg-brand text-white py-2.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
          >
            <Phone className="h-4 w-4" />
            {s.radar_cta_call}
          </button>
      )}

      <AiBridgeSheet
        open={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        vendor={vendor}
        callerPhone={getUserPhone() ?? ""}
        userNeed={userNeed}
        categoryId={matchedCategoryId}
        distanceKm={dist}
      />

      {showSendOrderSection &&
        (deliveryOrderSent ? (
          <div
            className={cn(
              "mt-2 w-full rounded-xl border px-3 py-2.5 text-sm",
              "border-brand/50 bg-brand/5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1",
            )}
          >
            <span className="text-muted-foreground font-medium">
              {serviceMode === "appointment"
                ? `📅 ${s.radar_booking_requested}`
                : `✅ ${s.radar_order_sent}`}
            </span>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={() => void openParchi()}
              className="font-semibold text-green-700 dark:text-brand underline underline-offset-2 hover:opacity-90"
            >
              {serviceMode === "appointment" ? s.radar_book_again : s.radar_send_new_order}
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="radar-vendor-card-order-btn"
            onClick={() => void openParchi()}
            className="mt-2 w-full rounded-xl bg-brand text-white py-2.5 px-3 text-sm font-semibold active:scale-[0.99] transition-transform"
          >
            {serviceMode === "appointment" ? s.radar_cta_book : serviceMode === "delivery" ? s.radar_cta_order : s.radar_send_order}
          </button>
        ))}

      {showResolution && (
        <button
          type="button"
          onClick={handleResolution}
          disabled={resolutionMarked || resolutionBusy}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-brand/70 text-brand bg-transparent",
            "hover:bg-brand-muted",
            (resolutionMarked || resolutionBusy) && "opacity-60 cursor-not-allowed hover:bg-transparent",
          )}
        >
          {resolutionMarked
            ? `✅ ${s.radar_marked}`
            : serviceMode === "delivery"
              ? `📦 ${s.radar_delivered_on_time}`
              : serviceMode === "appointment"
                ? `✅ ${s.radar_vendor_served}`
                : `✅ ${s.radar_vendor_helped}`}
        </button>
      )}

      {showSaveRow && (
        <button
          type="button"
          onClick={() => beginSaveVendor()}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-border text-foreground bg-muted/40 hover:bg-muted/60",
          )}
        >
          {`🔖 ${s.radar_save_as}${getLabel(vendor.category) || s.radar_vendor_fallback}`}
        </button>
      )}
      {showUnsaveRow && (
        <button
          type="button"
          onClick={() => void handleUnsaveVendor()}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-border text-muted-foreground bg-muted/30 hover:bg-muted/50",
          )}
        >
          {s.neighbours_saved_button}
        </button>
      )}
      <ParchiSheet
        vendor={parchiVendor}
        vendorId={vendor.id}
        serviceMode={serviceMode}
        orderCategoryId={categories[0]?.category_id ?? null}
        orderCategoryLabel={categories[0]?.label ?? null}
        orderCategoryReach={categoryReach}
        isOpen={parchiOpen}
        onClose={() => setParchiOpen(false)}
        onOrderSent={() => setResolutionSessionTick((n) => n + 1)}
        onOrderCancelled={handleOrderCancelled}
      />
      <PhoneEntrySheet
        isOpen={phoneSheetOpen}
        context="save"
        skipRecovery
        onClose={() => setPhoneSheetOpen(false)}
        onConfirmed={async (phone) => {
          setPhoneSheetOpen(false);
          await migrateUserPhone(phone, getDeviceId());
          setSaveNicknameDraft("");
          setSaveNicknameSheetOpen(true);
        }}
      />
      <Sheet
        open={saveNicknameSheetOpen}
        onOpenChange={(open) => {
          if (!open) setSaveNicknameSheetOpen(false);
        }}
      >
        <SheetContent
          side="bottom"
          className="bg-card border-t border-border rounded-t-2xl"
        >
          <SheetHeader className="text-left pr-8">
            <SheetTitle>
              {`🔖 ${s.radar_save_as}${getLabel(vendor.category) || s.radar_vendor_fallback}`}
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-3">
            <label className="text-xs font-medium text-muted-foreground">
              {s.neighbours_nickname_label}
            </label>
            <input
              data-testid="radar-save-nickname-input"
              type="text"
              value={saveNicknameDraft}
              onChange={(e) => setSaveNicknameDraft(e.target.value)}
              placeholder={s.neighbours_nickname_placeholder}
              maxLength={40}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              data-testid="radar-save-nickname-confirm"
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3 font-semibold active:scale-[0.98]"
              onClick={() => void handleSaveVendor(saveNicknameDraft)}
            >
              {s.neighbours_nickname_save}
            </button>
            <button
              type="button"
              className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
              onClick={() => setSaveNicknameSheetOpen(false)}
            >
              {s.cancel}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
    {lightboxOpen && (
      <div
        className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"
        onClick={() => setLightboxOpen(false)}
      >
        {lightboxUrl && (
          <img
            src={lightboxUrl}
            alt=""
            className="max-w-[80vw] max-h-[80vh] object-contain rounded-lg"
          />
        )}
      </div>
    )}
    </>
  );
}
