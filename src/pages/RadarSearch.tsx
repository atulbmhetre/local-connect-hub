import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { NetworkErrorBanner } from "@/components/NetworkErrorBanner";
import { NotificationBell } from "@/components/NotificationBell";
import {
  ArrowLeft,
  MapPin,
  AlertTriangle,
  Shield,
  ShieldAlert,
  Loader2,
  Siren,
  ChevronDown,
  Zap,
  PhoneCall,
  Search,
} from "lucide-react";
import {
  supabase,
  type Vendor,
  type Category,
  distanceKm,
  displayName,
  useCategoryLabel,
  invokeSuggestCategory,
} from "@/lib/supabase";
import {
  RadarVendorCard,
  consumeNeighboursDirty,
  readSessionSaved,
} from "@/components/RadarVendorCard";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { isWebDesktopShell, useLgUp } from "@/lib/desktopShell";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useLanguage } from "@/lib/language";
import {
  applyAbortSignal,
  isNetworkFailure,
  isNetworkTimeout,
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import { useAppConfig } from "@/hooks/useAppConfig";
import {
  computeTrustLevelsByVendorCategory,
  vendorCategoryTrustKey,
  type TrustLevel,
  type VendorVerificationRow,
  type BusinessLocationRow,
} from "@/lib/trustLevel";
import {
  bestMatchingMenuItem,
  compareRadarResultsWithMenuMatch,
  promoteMatchedMenuPreview,
  shouldApplyRadarMenuRanking,
} from "@/lib/radarMenuMatch";
import {
  DEFAULT_SERVICE_RADIUS_KM,
  PAN_INDIA_RADIUS_KM,
  normalizeServiceRadiusKm,
} from "@/lib/serviceRadius";
import {
  excludeOfflineHelpVendors,
  isPanIndiaServiceRadius,
  mergeRadarTracks,
  passesTrackARadiusFilter,
  trackQueryHitCap,
} from "@/lib/radarVendorFilter";
import { liveLocationFreshSinceIso } from "@/lib/vendorLiveStaleness";
import { isVendorSubscriptionVisibleOnRadar } from "@/lib/radarSubscription";
import {
  resolveCategoryBrandName,
  resolveCategoryReach,
  resolveCategoryServiceRadius,
  resolveCategoryVendorNote,
  mapPublicCategoryOrderStats,
  vendorCategoryReputationKey,
  type VendorCategoryReputation,
} from "@/lib/categoryScopedVendor";
import {
  expandRadarModeMatches,
  radarResultKey,
  stampVendorWithBusiness,
  usableRadarShopPin,
} from "@/lib/radarBusinessCards";
import {
  govEmergencyHelpLinesForTerm,
  isOfficialEmergencyCategory,
  isPharmacyMedicalSearch,
  resolveCanonicalTerm,
  resolveCanonicalTerms,
  showGovHelpAlongsideRadiusExpand,
} from "@/lib/categories";
import { refreshCategorySearchTermsCache } from "@/lib/categorySearchTerms";
import { groupRadarResultsByCategory } from "@/lib/radarResultGroups";

const RADAR_SUBSCRIPTION_OR =
  "subscription_status.is.null,subscription_status.in.(trial,active,grace)";

export type RadarMenuItem = {
  name: string;
  price: number;
  unit: string | null;
  is_available: boolean;
  image_url?: string | null;
};

const RADAR_VC_SELECT =
  "vendor_id, category_id, is_primary, brand_name, serves_at_vendor_place, serves_at_customer_place, service_radius_km, vendor_note, inspection_fee, min_delivery_order_amount, is_manual_verified, shop_photo_url, verification_status, gps_match_distance, location_accuracy, photo_accuracy, latitude, longitude, upi_id, upi_qr_url, upi_qr_payee_id, service_mode, categories(label, emoji)";

export type RadarVendorCategory = {
  label: string;
  emoji: string;
  category_id: string;
  brand_name?: string | null;
  serves_at_vendor_place?: boolean | null;
  serves_at_customer_place?: boolean | null;
  service_radius_km?: number | null;
  vendor_note?: string | null;
  inspection_fee?: number | null;
  min_delivery_order_amount?: number | null;
  is_manual_verified?: boolean | null;
  shop_photo_url?: string | null;
  verification_status?: string | null;
  gps_match_distance?: number | null;
  location_accuracy?: number | null;
  photo_accuracy?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  upi_id?: string | null;
  upi_qr_url?: string | null;
  upi_qr_payee_id?: string | null;
  service_mode?: string | null;
};

export type RadarVendorResult = Vendor & {
  categories: RadarVendorCategory[];
  trustLevel: TrustLevel;
  /** First 5 available menu items, batch-fetched so cards render complete. */
  menuPreview: RadarMenuItem[];
  /** Menu line that matched the more-specific search term (help/appointment only). */
  matchedMenuName?: string | null;
  hasActiveOrder: boolean;
  hasFulfilledOrder: boolean;
  fulfilledRequestId: string | null;
  isSavedNeighbour: boolean;
  isPanIndia?: boolean;
  /** Display brand for matched category context (falls back to shop_name). */
  displayBrandName?: string;
  /** Effective service radius for matched category context. */
  effectiveServiceRadiusKm?: number | null;
};

type Ranked = { vendor: RadarVendorResult; dist: number | null };

type RadarMode = "help" | "delivery" | "appointment";

function parseRadarMode(raw: string | null): RadarMode | null {
  const m = raw?.trim().toLowerCase();
  if (m === "help" || m === "delivery" || m === "appointment") return m;
  return null;
}

function resolveAllCategoryIdsForTerm(term: string, categories: Category[]): string[] {
  const matches = resolveCanonicalTerms(term);
  if (matches.length > 0) {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const m of matches) {
      const exact = categories.find(
        (c) =>
          c.id === m.categoryId ||
          c.label.toLowerCase() === m.label.toLowerCase(),
      );
      if (exact && !seen.has(exact.id)) {
        seen.add(exact.id);
        ids.push(exact.id);
      }
    }
    if (ids.length > 0) return ids;
  }
  const t = term.trim().toLowerCase();
  if (!t) return [];
  return categories
    .filter(
      (c) =>
        c.label.toLowerCase().includes(t) ||
        t.includes(c.label.toLowerCase()),
    )
    .map((c) => c.id);
}

function inferModeFromCategoryIds(
  categoryIds: string[],
  categories: Category[],
): RadarMode | null {
  const modes = new Set<RadarMode>();
  for (const id of categoryIds) {
    const cat = categories.find((c) => c.id === id);
    if (cat?.service_mode === "help" || cat?.service_mode === "delivery" || cat?.service_mode === "appointment") {
      modes.add(cat.service_mode);
    }
  }
  if (modes.size !== 1) return null;
  return [...modes][0];
}

function radarModeDisplayLabel(
  mode: RadarMode,
  s: {
    radar_mode_help: string;
    radar_mode_delivery: string;
    radar_mode_booking: string;
  },
): string {
  if (mode === "delivery") return s.radar_mode_delivery;
  if (mode === "appointment") return s.radar_mode_booking;
  return s.radar_mode_help;
}

type RadarCategoryModeMatch = { vendor_id: string; category_id: string };

function buildMatchedCategoryIdsByVendor(
  rows: RadarCategoryModeMatch[],
): Map<string, Set<string>> {
  const matched = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!matched.has(row.vendor_id)) {
      matched.set(row.vendor_id, new Set());
    }
    matched.get(row.vendor_id)!.add(row.category_id);
  }
  return matched;
}

function resolveCategoryIdsForTerm(
  term: string,
  categories: Category[],
  _serviceMode: RadarMode,
): string[] {
  return resolveAllCategoryIdsForTerm(term, categories);
}

function RadarModeSelector({
  selectedMode,
  onModeChange,
}: {
  selectedMode: RadarMode;
  onModeChange: (mode: RadarMode) => void;
}) {
  const { s } = useLanguage();
  const modes: {
    id: RadarMode;
    emoji: string;
    label: keyof typeof s;
    sub: keyof typeof s;
  }[] = [
    { id: "help", emoji: "🆘", label: "radar_mode_help", sub: "radar_mode_help_sub" },
    { id: "delivery", emoji: "📦", label: "radar_mode_delivery", sub: "radar_mode_delivery_sub" },
    { id: "appointment", emoji: "📅", label: "radar_mode_booking", sub: "radar_mode_booking_sub" },
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {modes.map((mode) => {
        const selected = selectedMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            data-testid={`radar-mode-${mode.id}`}
            onClick={() => onModeChange(mode.id)}
            className={cn(
              "min-h-[64px] rounded-xl px-2 py-2 flex flex-col items-center justify-center gap-0.5 transition-colors active:scale-[0.98]",
              selected
                ? "bg-brand text-white"
                : "bg-muted text-muted-foreground border border-surface-border",
            )}
          >
            <span className="text-lg leading-none" aria-hidden>
              {mode.emoji}
            </span>
            <span className="text-xs font-semibold leading-tight">{s[mode.label] as string}</span>
            <span
              className={cn(
                "text-xs leading-tight text-center",
                selected ? "text-white/80" : "text-muted-foreground",
              )}
            >
              {s[mode.sub] as string}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function buildVendorCategoriesMap(
  rows: {
    vendor_id: string;
    category_id: string;
    is_primary: boolean | null;
    brand_name?: string | null;
    serves_at_vendor_place?: boolean | null;
    serves_at_customer_place?: boolean | null;
    service_radius_km?: number | null;
    vendor_note?: string | null;
    inspection_fee?: number | null;
    min_delivery_order_amount?: number | null;
    is_manual_verified?: boolean | null;
    shop_photo_url?: string | null;
    verification_status?: string | null;
    gps_match_distance?: number | null;
    location_accuracy?: number | null;
    photo_accuracy?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    upi_id?: string | null;
    upi_qr_url?: string | null;
    upi_qr_payee_id?: string | null;
    service_mode?: string | null;
    categories: { label: string; emoji: string } | { label: string; emoji: string }[] | null;
  }[],
  matchedCategoryIdsByVendor?: Map<string, Set<string>>,
): Map<string, RadarVendorCategory[]> {
  const map = new Map<string, (RadarVendorCategory & { is_primary: boolean })[]>();

  for (const row of rows) {
    const cat = row.categories;
    const resolved = Array.isArray(cat) ? cat[0] : cat;
    if (!resolved?.label) continue;

    const list = map.get(row.vendor_id) ?? [];
    list.push({
      label: resolved.label,
      emoji: resolved.emoji ?? "✨",
      is_primary: row.is_primary === true,
      category_id: row.category_id,
      brand_name: row.brand_name,
      serves_at_vendor_place: row.serves_at_vendor_place,
      serves_at_customer_place: row.serves_at_customer_place,
      service_radius_km: row.service_radius_km,
      vendor_note: row.vendor_note,
      inspection_fee:
        row.inspection_fee != null && Number(row.inspection_fee) > 0
          ? Number(row.inspection_fee)
          : null,
      min_delivery_order_amount:
        row.min_delivery_order_amount != null && Number(row.min_delivery_order_amount) > 0
          ? Number(row.min_delivery_order_amount)
          : null,
      is_manual_verified: row.is_manual_verified,
      shop_photo_url: row.shop_photo_url,
      verification_status: row.verification_status,
      gps_match_distance: row.gps_match_distance,
      location_accuracy: row.location_accuracy,
      photo_accuracy: row.photo_accuracy,
      latitude: row.latitude,
      longitude: row.longitude,
      upi_id: row.upi_id,
      upi_qr_url: row.upi_qr_url,
      upi_qr_payee_id: row.upi_qr_payee_id,
      service_mode: row.service_mode,
    });
    map.set(row.vendor_id, list);
  }

  const out = new Map<string, RadarVendorCategory[]>();
  for (const [vendorId, list] of map) {
    const matched = matchedCategoryIdsByVendor?.get(vendorId);
    const filtered =
      matchedCategoryIdsByVendor != null && matched
        ? list.filter((c) => matched.has(c.category_id))
        : list;
    filtered.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    out.set(
      vendorId,
      filtered.map(({ is_primary: _isPrimary, ...rest }) => rest),
    );
  }
  return out;
}

/** ~55 km at Indian latitudes; floor for customer-centered bbox. */
const BBOX_DELTA_DEG = 0.5;
const KM_PER_DEG_LAT = 111;
const GPS_TIMEOUT_MS = 10_000;
const TRACK_A_LIMIT = 80;
const TRACK_B_LIMIT = 20;

const RADAR_BRACKET_OPTIONS = [
  { value: 15, labelKey: "radar_bracket_15" as const },
  { value: 25, labelKey: "radar_bracket_25" as const },
  { value: 50, labelKey: "radar_bracket_50" as const },
  { value: 100, labelKey: "radar_bracket_100" as const },
  { value: 500, labelKey: "radar_bracket_500" as const },
  { value: PAN_INDIA_RADIUS_KM, labelKey: "radar_bracket_india" as const },
];

type LocationHighlightState = { highlightVendorId?: string };

function RadarVendorCardSkeleton() {
  return (
    <div
      className="mb-3 rounded-2xl border border-surface-border bg-surface p-4 animate-pulse"
      aria-hidden
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-muted shrink-0" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-4 w-3/5 rounded-md bg-muted" />
          <div className="h-3 w-2/5 rounded-md bg-muted" />
          <div className="h-3 w-1/3 rounded-md bg-muted" />
        </div>
      </div>
      <div className="mt-4 h-10 w-full rounded-xl bg-muted" />
    </div>
  );
}

const RadarSearch = () => {
  const lgUp = useLgUp();
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getCategoryLabel = useCategoryLabel();
  const navigate = useNavigate();
  const location = useLocation();
  const highlightVendorId = (location.state as LocationHighlightState | null)?.highlightVendorId;
  const [flashVendorId, setFlashVendorId] = useState<string | null>(null);
  const [params, setSearchParams] = useSearchParams();
  const term = (params.get("q") ?? "").trim();
  const urlMode = parseRadarMode(params.get("mode"));
  const [selectedMode, setSelectedMode] = useState<RadarMode>(() => urlMode ?? "help");
  const [searchDraft, setSearchDraft] = useState("");
  const [modeMismatchHint, setModeMismatchHint] = useState<{
    suggestedMode: RadarMode;
    categoryId: string;
    categoryName: string;
  } | null>(null);
  const [forcedCategoryId, setForcedCategoryId] = useState<string | null>(null);

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsTried, setCoordsTried] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [scanning, setScanning] = useState(true);
  /** Customer distance bracket in km (15–500) or Pan-India sentinel (9999). */
  const [searchRadiusKm, setSearchRadiusKm] = useState(DEFAULT_SERVICE_RADIUS_KM);
  const [results, setResults] = useState<Ranked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [networkSearchFailed, setNetworkSearchFailed] = useState(false);
  const [networkSearchTimedOut, setNetworkSearchTimedOut] = useState(false);
  const [resultsTruncated, setResultsTruncated] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  /**
   * Search must not run before the categories lookup resolves: with an empty
   * categories list the term resolves to zero ids and the search would
   * early-return setResults([]), flashing "0 results" before the real fetch.
   */
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [categoriesNetworkStatus, setCategoriesNetworkStatus] = useState<
    "failed" | "timeout" | null
  >(null);
  /** Bumped when neighbours_dirty is consumed so isSaved re-reads session flags. */
  const [neighboursSyncTick, setNeighboursSyncTick] = useState(0);
  const [suggestedCategoryName, setSuggestedCategoryName] = useState<string | null>(null);
  const [unknownTermBrowse, setUnknownTermBrowse] = useState(false);
  /** Monotonic id so a stale in-flight fetch can never overwrite newer results. */
  const fetchSeqRef = useRef(0);

  const loadCategories = useCallback(async () => {
    setCategoriesNetworkStatus(null);
    try {
      const { data, error: catError } = await withTimedRetry(
        async (signal) =>
          throwOnSupabaseNetworkError(
            await applyAbortSignal(
              supabase
                .from("categories")
                .select("id, label, emoji, service_mode, is_active, sort_order")
                .eq("is_active", true)
                .order("sort_order", { ascending: true }),
              signal,
            ),
          ),
        {
          onRetrying: () =>
            showNetworkRetryingToast({ retrying: s.network_retrying }),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (catError) {
        console.error("radar categories load", catError);
        setCategories([]);
        setCategoriesNetworkStatus("failed");
        setCategoriesLoaded(true);
        return;
      }
      setCategories((data ?? []) as Category[]);
      try {
        await refreshCategorySearchTermsCache();
      } catch {
        /* seed fallback lives inside refreshCategorySearchTermsCache */
      }
      setCategoriesLoaded(true);
      setCategoriesNetworkStatus(null);
    } catch (err) {
      dismissNetworkRetryingToast();
      console.error("radar categories load", err);
      setCategories([]);
      setCategoriesLoaded(true);
      setCategoriesNetworkStatus(
        isNetworkTimeout(err) || err instanceof NetworkExhaustedError
          ? isNetworkTimeout(err)
            ? "timeout"
            : "failed"
          : "failed",
      );
    }
  }, [s.network_retrying]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);

  const isPanIndiaBracket = searchRadiusKm === PAN_INDIA_RADIUS_KM;
  const locating = !coordsTried;
  const locatingFullBleed = locating && isWebDesktopShell() && lgUp;
  const locationBlocked = coordsTried && coords == null && !isPanIndiaBracket;

  useEffect(() => {
    if (!categoriesLoaded) return;
    if (urlMode) {
      setSelectedMode(urlMode);
      return;
    }
    if (!term) {
      setSelectedMode("help");
      return;
    }
    const inferred = inferModeFromCategoryIds(
      resolveAllCategoryIdsForTerm(term, categories),
      categories,
    );
    if (inferred) setSelectedMode(inferred);
  }, [categoriesLoaded, term, urlMode, categories]);

  useEffect(() => {
    setSearchDraft(term);
  }, [term]);

  useLayoutEffect(() => {
    setSearchRadiusKm(DEFAULT_SERVICE_RADIUS_KM);
    setSuggestedCategoryName(null);
    setUnknownTermBrowse(false);
    setModeMismatchHint(null);
    setForcedCategoryId(null);
  }, [term]);

  const handleModeChange = useCallback(
    (mode: RadarMode) => {
      setSelectedMode(mode);
      setSearchRadiusKm(DEFAULT_SERVICE_RADIUS_KM);
      setSearchParams({ mode });
      setSearchDraft("");
      setSuggestedCategoryName(null);
      setUnknownTermBrowse(false);
      setModeMismatchHint(null);
      setForcedCategoryId(null);
    },
    [setSearchParams],
  );

  const handleSwitchToSuggestedMode = useCallback(() => {
    if (!modeMismatchHint) return;
    setSelectedMode(modeMismatchHint.suggestedMode);
    setSearchRadiusKm(DEFAULT_SERVICE_RADIUS_KM);
    setForcedCategoryId(modeMismatchHint.categoryId);
    setModeMismatchHint(null);
    setUnknownTermBrowse(false);
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    next.set("mode", modeMismatchHint.suggestedMode);
    setSearchParams(next);
  }, [modeMismatchHint, term, setSearchParams]);

  const handleSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const t = searchDraft.trim();
      const next = new URLSearchParams();
      if (t) next.set("q", t);
      next.set("mode", selectedMode);
      setSearchParams(next);
      setModeMismatchHint(null);
      setForcedCategoryId(null);
    },
    [searchDraft, selectedMode, setSearchParams],
  );

  const requestLocation = useCallback(() => {
    setCoordsTried(false);
    setCoords(null);
    setLocationDenied(false);
    setScanning(true);
    setError(null);
    setResults([]);
    setSuggestedCategoryName(null);
    setUnknownTermBrowse(false);
    setModeMismatchHint(null);
    setForcedCategoryId(null);

    if (!("geolocation" in navigator)) {
      setCoordsTried(true);
      setScanning(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (p) => {
        setCoords({ lat: p.coords.latitude, lng: p.coords.longitude });
        setCoordsTried(true);
        setLocationDenied(false);
      },
      (err) => {
        setCoordsTried(true);
        setCoords(null);
        setLocationDenied(err.code === 1);
        setScanning(false);
      },
      { enableHighAccuracy: true, timeout: GPS_TIMEOUT_MS, maximumAge: 30_000 },
    );
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  const openLocationSettings = () => {
    if (Capacitor.isNativePlatform()) {
      void App.openUrl({ url: "app-settings:" });
      return;
    }
    void App.openUrl({ url: "app-settings:" }).catch(() => {
      /* best-effort on web */
    });
  };

  const fetchVendors = useCallback(
    async (opts: { silent?: boolean }) => {
      const userBracket = normalizeServiceRadiusKm(searchRadiusKm);
      const panIndiaOnly = userBracket === PAN_INDIA_RADIUS_KM;

      if (!coords && !panIndiaOnly) {
        if (coordsTried && !opts.silent) setScanning(false);
        return;
      }
      // Categories not loaded yet: keep the spinner up and bail. The search
      // effect re-runs once categoriesLoaded flips, so nothing is lost.
      if (!categoriesLoaded) return;
      const seq = ++fetchSeqRef.current;
      const isCurrent = () => seq === fetchSeqRef.current;
      if (!opts.silent) {
        setScanning(true);
        setError(null);
        setNetworkSearchFailed(false);
        setNetworkSearchTimedOut(false);
        setResultsTruncated(false);
      }
      try {
        let vendorIdFilter: string[] | null = null;
        let matchedCategoryIdsByVendor: Map<string, Set<string>> | undefined;
        let resolvedCategoryLabels: string[] = [];
        if (term) {
          setModeMismatchHint(null);

          let categoryIds = resolveCategoryIdsForTerm(term, categories, selectedMode);
          let aiSuggestedName: string | null = null;

          if (
            categoryIds.length === 0 &&
            forcedCategoryId &&
            categories.some((c) => c.id === forcedCategoryId)
          ) {
            categoryIds = [forcedCategoryId];
            aiSuggestedName =
              categories.find((c) => c.id === forcedCategoryId)?.label ?? null;
          }

          if (categoryIds.length === 0 && !resolveCanonicalTerm(term)) {
            const result = await invokeSuggestCategory({ description: term });
            if (!result.success) {
              if (isCurrent()) {
                toast.info(s.search_category_unavailable, { duration: 4000 });
                setResults([]);
                setUnknownTermBrowse(true);
                setSuggestedCategoryName(null);
              }
              return;
            }
            const threshold = config.aiCategoryConfidenceThreshold ?? 0.85;
            if (
              result.success &&
              result.outcome === "high_existing" &&
              result.category_id &&
              (result.confidence ?? 0) >= threshold
            ) {
              const suggestedCat = categories.find((c) => c.id === result.category_id);
              const suggestedMode = parseRadarMode(
                suggestedCat?.service_mode ?? result.service_mode ?? null,
              );
              if (suggestedCat && suggestedMode === selectedMode) {
                categoryIds = [result.category_id];
                aiSuggestedName = result.category_name ?? suggestedCat.label;
              } else if (suggestedCat && suggestedMode && suggestedMode !== selectedMode) {
                if (isCurrent()) {
                  setResults([]);
                  setUnknownTermBrowse(false);
                  setSuggestedCategoryName(null);
                  setModeMismatchHint({
                    suggestedMode,
                    categoryId: result.category_id,
                    categoryName: result.category_name ?? suggestedCat.label,
                  });
                }
                return;
              }
            }
            if (categoryIds.length === 0) {
              if (isCurrent()) {
                setResults([]);
                setUnknownTermBrowse(true);
                setSuggestedCategoryName(null);
              }
              return;
            }
          }

          if (isCurrent()) {
            setUnknownTermBrowse(false);
            setSuggestedCategoryName(aiSuggestedName);
          }

          if (categoryIds.length === 0) {
            if (isCurrent()) setResults([]);
            return;
          }
          if (forcedCategoryId && categoryIds.includes(forcedCategoryId) && isCurrent()) {
            setForcedCategoryId(null);
          }
          resolvedCategoryLabels = categoryIds
            .map((id) => categories.find((c) => c.id === id)?.label ?? "")
            .filter((label) => label.length > 0);
          const { data: modeMatchRows, error: modeMatchError } = await withTimedRetry(
            async (signal) =>
              throwOnSupabaseNetworkError(
                await applyAbortSignal(
                  supabase.rpc("get_radar_category_mode_matches", {
                    p_mode: selectedMode,
                    p_category_ids: categoryIds,
                  }),
                  signal,
                ),
              ),
            { shouldRetry: () => getNavigatorOnline() },
          );
          if (modeMatchError) throw modeMatchError;
          const modeMatches = expandRadarModeMatches(
            (modeMatchRows ?? []) as RadarCategoryModeMatch[],
          );
          matchedCategoryIdsByVendor = buildMatchedCategoryIdsByVendor(modeMatches);
          vendorIdFilter = [...matchedCategoryIdsByVendor.keys()];
          if (vendorIdFilter.length === 0) {
            if (isCurrent()) setResults([]);
            return;
          }
        } else {
          if (isCurrent()) {
            setUnknownTermBrowse(false);
            setSuggestedCategoryName(null);
          }
          const { data: modeMatchRows, error: modeMatchError } = await withTimedRetry(
            async (signal) =>
              throwOnSupabaseNetworkError(
                await applyAbortSignal(
                  supabase.rpc("get_radar_category_mode_matches", {
                    p_mode: selectedMode,
                    p_category_ids: null,
                  }),
                  signal,
                ),
              ),
            { shouldRetry: () => getNavigatorOnline() },
          );
          if (modeMatchError) throw modeMatchError;
          const modeMatches = expandRadarModeMatches(
            (modeMatchRows ?? []) as RadarCategoryModeMatch[],
          );
          matchedCategoryIdsByVendor = buildMatchedCategoryIdsByVendor(modeMatches);
          vendorIdFilter = [...matchedCategoryIdsByVendor.keys()];
          if (vendorIdFilter.length === 0) {
            if (isCurrent()) setResults([]);
            return;
          }
        }

        const bboxDeltaDeg = Math.max(BBOX_DELTA_DEG, userBracket / KM_PER_DEG_LAT);

        let qTrackA = panIndiaOnly || !coords
          ? null
          : supabase
              .from("vendor_categories")
              .select(RADAR_VC_SELECT)
              .eq("status", "approved")
              .or(`service_radius_km.is.null,service_radius_km.lt.${PAN_INDIA_RADIUS_KM}`)
              .gte("latitude", coords.lat - bboxDeltaDeg)
              .lte("latitude", coords.lat + bboxDeltaDeg)
              .gte("longitude", coords.lng - bboxDeltaDeg)
              .lte("longitude", coords.lng + bboxDeltaDeg)
              .in("vendor_id", vendorIdFilter);

        /** Wide-radius businesses may sit outside the customer bbox but still cover the customer. */
        let qTrackAWide =
          panIndiaOnly || !coords
            ? null
            : supabase
                .from("vendor_categories")
                .select(RADAR_VC_SELECT)
                .eq("status", "approved")
                .gte("service_radius_km", userBracket)
                .lt("service_radius_km", PAN_INDIA_RADIUS_KM)
                .in("vendor_id", vendorIdFilter);

        let qTrackB = supabase
          .from("vendor_categories")
          .select(RADAR_VC_SELECT)
          .eq("status", "approved")
          .eq("service_radius_km", PAN_INDIA_RADIUS_KM)
          .in("vendor_id", vendorIdFilter);

        const [trackAResult, trackAWideResult, trackBResult] = await withTimedRetry(
          async (signal) => {
            const [a, aWide, b] = await Promise.all([
              qTrackA
                ? applyAbortSignal(qTrackA.limit(TRACK_A_LIMIT), signal)
                : Promise.resolve({ data: [], error: null }),
              qTrackAWide
                ? applyAbortSignal(qTrackAWide.limit(TRACK_A_LIMIT), signal)
                : Promise.resolve({ data: [], error: null }),
              applyAbortSignal(qTrackB.limit(TRACK_B_LIMIT), signal),
            ]);
            throwOnSupabaseNetworkError(a);
            throwOnSupabaseNetworkError(aWide);
            throwOnSupabaseNetworkError(b);
            return [a, aWide, b] as const;
          },
          { shouldRetry: () => getNavigatorOnline() },
        );

        if (trackAResult.error) throw trackAResult.error;
        if (trackAWideResult.error) throw trackAWideResult.error;
        if (trackBResult.error) throw trackBResult.error;

        const trackAHitCap =
          trackQueryHitCap(trackAResult.data?.length ?? 0, TRACK_A_LIMIT) ||
          trackQueryHitCap(trackAWideResult.data?.length ?? 0, TRACK_A_LIMIT);
        const trackBHitCap = trackQueryHitCap(trackBResult.data?.length ?? 0, TRACK_B_LIMIT);

        const matchFilter = matchedCategoryIdsByVendor;
        const keepMatchedBusiness = (row: {
          vendor_id: string;
          category_id: string;
          verification_status?: string | null;
        }) => {
          if (row.verification_status === "pending_location_review") return false;
          if (!matchFilter) return false;
          return matchFilter.get(row.vendor_id)?.has(row.category_id) === true;
        };

        type VcTrackRow = Parameters<typeof buildVendorCategoriesMap>[0][number];
        const trackAByPair = new Map<string, VcTrackRow>();
        for (const row of [
          ...((trackAResult.data ?? []) as VcTrackRow[]),
          ...((trackAWideResult.data ?? []) as VcTrackRow[]),
        ]) {
          if (!keepMatchedBusiness(row)) continue;
          trackAByPair.set(radarResultKey(row.vendor_id, row.category_id), row);
        }
        const trackBByPair = new Map<string, VcTrackRow>();
        for (const row of (trackBResult.data ?? []) as VcTrackRow[]) {
          if (!keepMatchedBusiness(row)) continue;
          trackBByPair.set(radarResultKey(row.vendor_id, row.category_id), row);
        }

        const vendorIds = [
          ...new Set([
            ...[...trackAByPair.values()].map((r) => r.vendor_id),
            ...[...trackBByPair.values()].map((r) => r.vendor_id),
          ]),
        ];

        let accountById = new Map<string, Vendor>();
        if (vendorIds.length > 0) {
          let qAccounts = supabase
            .from("vendors")
            .select("*, verification_status")
            .eq("is_banned", false)
            .eq("profile_status", "complete")
            .or(RADAR_SUBSCRIPTION_OR)
            .eq("discoverable", true)
            .in("id", vendorIds);
          if (selectedMode === "help") {
            // Server-side: only vendors with fresh GPS (≤45m) appear live on Help.
            qAccounts = qAccounts
              .eq("is_active", true)
              .gte("last_updated", liveLocationFreshSinceIso());
          }
          const accountsResult = await withTimedRetry(
            async (signal) =>
              throwOnSupabaseNetworkError(await applyAbortSignal(qAccounts, signal)),
            { shouldRetry: () => getNavigatorOnline() },
          );
          if (accountsResult.error) throw accountsResult.error;
          let accounts = (accountsResult.data ?? []) as Vendor[];
          accounts = excludeOfflineHelpVendors(accounts, selectedMode);
          accounts = accounts.filter(isVendorSubscriptionVisibleOnRadar);
          accountById = new Map(accounts.map((v) => [v.id, v]));
        }

        const pruneUnlisted = (map: Map<string, VcTrackRow>) => {
          for (const [key, row] of [...map.entries()]) {
            if (!accountById.has(row.vendor_id)) map.delete(key);
          }
        };
        pruneUnlisted(trackAByPair);
        pruneUnlisted(trackBByPair);

        let verificationRows: VendorVerificationRow[] = [];
        let businessRows: BusinessLocationRow[] = [];
        let categoriesByVendor = new Map<string, RadarVendorCategory[]>();
        const menuByBusiness = new Map<string, RadarMenuItem[]>();
        let activeOrderVendorIds = new Set<string>();
        let fulfilledVendorIds = new Set<string>();
        const fulfilledRequestByVendor = new Map<string, string>();
        let savedVendorIds = new Set<string>();

        if (vendorIds.length > 0) {
          const deviceId = getDeviceId();
          const userPhone = getUserPhone();
          const [activeResult, fulfilledResult, savedResult] = await withTimedRetry(
            async (signal) => {
              const [active, fulfilled, saved] = await Promise.all([
                applyAbortSignal(
                  supabase.rpc("get_my_active_request_vendor_ids", {
                    p_user_phone: userPhone,
                    p_device_id: deviceId,
                    p_vendor_ids: vendorIds,
                  }),
                  signal,
                ),
                applyAbortSignal(
                  supabase.rpc("get_my_fulfilled_request_ids", {
                    p_user_phone: userPhone,
                    p_device_id: deviceId,
                    p_vendor_ids: vendorIds,
                  }),
                  signal,
                ),
                applyAbortSignal(
                  supabase.rpc("get_saved_vendors", {
                    p_user_phone: userPhone,
                    p_device_id: deviceId,
                  }),
                  signal,
                ),
              ]);
              throwOnSupabaseNetworkError(active);
              throwOnSupabaseNetworkError(fulfilled);
              throwOnSupabaseNetworkError(saved);
              return [active, fulfilled, saved] as const;
            },
            { shouldRetry: () => getNavigatorOnline() },
          );

          const [verResult, menuResult] = await Promise.all([
            supabase
              .from("vendor_verification")
              .select("vendor_id, check_type, status, is_latest")
              .in("vendor_id", vendorIds)
              .eq("is_latest", true),
            supabase
              .from("vendor_menu_items")
              .select("vendor_id, name, price, unit, is_available, category_id, image_url")
              .in("vendor_id", vendorIds)
              .eq("is_available", true)
              .order("sort_order", { ascending: true }),
          ]);

          if (verResult.error) {
            console.error("radar/vendor_verification", verResult.error);
          }
          verificationRows = (verResult.data ?? []) as VendorVerificationRow[];
          const trackRows = [...trackAByPair.values(), ...trackBByPair.values()];
          categoriesByVendor = buildVendorCategoriesMap(trackRows, matchFilter);
          businessRows = trackRows.map((r) => ({
            vendor_id: r.vendor_id,
            category_id: r.category_id,
            shop_photo_url: r.shop_photo_url,
            gps_match_distance: r.gps_match_distance,
            location_accuracy: r.location_accuracy,
            photo_accuracy: r.photo_accuracy,
            verification_status: r.verification_status,
          }));

          for (const row of menuResult.data ?? []) {
            if (!row.category_id) continue;
            const key = radarResultKey(row.vendor_id, row.category_id);
            const list = menuByBusiness.get(key) ?? [];
            list.push({
              name: row.name,
              price: row.price,
              unit: row.unit,
              is_available: row.is_available,
              image_url: row.image_url ?? null,
            });
            menuByBusiness.set(key, list);
          }
          activeOrderVendorIds = new Set((activeResult.data ?? []).map((r) => r.vendor_id));
          for (const row of fulfilledResult.data ?? []) {
            fulfilledVendorIds.add(row.vendor_id);
            if (!fulfilledRequestByVendor.has(row.vendor_id)) {
              fulfilledRequestByVendor.set(row.vendor_id, row.id);
            }
          }
          const vendorIdSet = new Set(vendorIds);
          savedVendorIds = new Set(
            ((savedResult.data ?? []) as { vendor_id: string }[])
              .map((r) => r.vendor_id)
              .filter((id) => vendorIdSet.has(id)),
          );
        }

        const trustKeys: Array<{ vendorId: string; categoryId: string }> = [];
        for (const [vid, cats] of categoriesByVendor) {
          for (const cat of cats) {
            if (cat.category_id) trustKeys.push({ vendorId: vid, categoryId: cat.category_id });
          }
        }
        const trustByVendorCategory = computeTrustLevelsByVendorCategory(
          trustKeys,
          verificationRows,
          businessRows,
        );

        let categoryRepMap = new Map<string, VendorCategoryReputation>();
        if (vendorIds.length > 0 && trustKeys.length > 0) {
          const categoryIds = [...new Set(trustKeys.map((k) => k.categoryId))];
          const { data: repRows, error: repError } = await supabase.rpc(
            "get_public_vendor_category_order_stats",
            {
              p_vendor_ids: vendorIds,
              p_category_ids: categoryIds,
            },
          );
          if (repError) {
            console.error("radar/category_order_stats", repError);
          } else {
            categoryRepMap = mapPublicCategoryOrderStats(repRows ?? []);
          }
        }

        const buildBusinessResult = (
          v: Vendor,
          matchedCat: RadarVendorCategory,
          extras: { dist: number | null; isPanIndia?: boolean },
        ): Ranked => {
          const matchedId = matchedCat.category_id;
          const displayBrandName = resolveCategoryBrandName(
            matchedCat.brand_name,
            v.shop_name,
            matchedId,
          );
          const effectiveServiceRadiusKm = resolveCategoryServiceRadius(
            matchedCat.service_radius_km,
            null,
            matchedId,
          );
          const trustLevel: TrustLevel =
            trustByVendorCategory.get(vendorCategoryTrustKey(v.id, matchedId)) ?? "Unverified";
          const rep = categoryRepMap.get(vendorCategoryReputationKey(v.id, matchedId));
          const fulfilled = rep?.fulfilled ?? 0;
          const displayVendorNote = resolveCategoryVendorNote(
            matchedCat.vendor_note,
            null,
            matchedId,
          );
          const stamped = stampVendorWithBusiness(v as unknown as Record<string, unknown>, matchedCat);
          const allMenu = menuByBusiness.get(radarResultKey(v.id, matchedId)) ?? [];
          const applyMenuRank = shouldApplyRadarMenuRanking({
            radarMode: selectedMode,
            searchTerm: term,
            categoryLabels: resolvedCategoryLabels,
          });
          const matchedMenu = applyMenuRank
            ? bestMatchingMenuItem(allMenu, term)
            : null;
          return {
            vendor: {
              ...(stamped as unknown as Vendor),
              vendor_note: displayVendorNote,
              inspection_fee: matchedCat.inspection_fee ?? null,
              min_delivery_order_amount: matchedCat.min_delivery_order_amount ?? null,
              categories: [matchedCat],
              trustLevel,
              menuPreview: promoteMatchedMenuPreview(allMenu, matchedMenu?.name ?? null, 5),
              matchedMenuName: matchedMenu?.name ?? null,
              hasActiveOrder: activeOrderVendorIds.has(v.id),
              hasFulfilledOrder: fulfilledVendorIds.has(v.id),
              fulfilledRequestId: fulfilledRequestByVendor.get(v.id) ?? null,
              isSavedNeighbour: savedVendorIds.has(v.id),
              isPanIndia: extras.isPanIndia,
              displayBrandName,
              effectiveServiceRadiusKm,
              total_helped: fulfilled,
              total_delivered: fulfilled,
              on_time_rate: rep?.onTimeRate ?? null,
            } as RadarVendorResult,
            dist: extras.dist,
          };
        };

        const trackARanked: Ranked[] = [];
        if (!panIndiaOnly && coords) {
          for (const row of trackAByPair.values()) {
            const v = accountById.get(row.vendor_id);
            if (!v) continue;
            const matchedCat = (categoriesByVendor.get(v.id) ?? []).find(
              (c) => c.category_id === row.category_id,
            );
            if (!matchedCat) continue;
            const pin = usableRadarShopPin(matchedCat.latitude, matchedCat.longitude);
            if (!pin) continue;
            const reach = resolveCategoryReach(
              matchedCat,
              {
                serves_at_vendor_place: matchedCat.serves_at_vendor_place,
                serves_at_customer_place: matchedCat.serves_at_customer_place,
              },
              matchedCat.category_id,
            );
            if (selectedMode === "delivery" && !reach.serves_at_customer_place) continue;
            const effectiveRadius = resolveCategoryServiceRadius(
              matchedCat.service_radius_km,
              null,
              matchedCat.category_id,
            );
            if (isPanIndiaServiceRadius(effectiveRadius)) continue;
            const dist = distanceKm(coords, pin);
            if (!passesTrackARadiusFilter(dist, userBracket, effectiveRadius)) continue;
            trackARanked.push(buildBusinessResult(v, matchedCat, { dist }));
          }
          trackARanked.sort((a, b) =>
            compareRadarResultsWithMenuMatch(
              {
                dist: a.dist,
                trustLevel: a.vendor.trustLevel,
                menuMatch: Boolean(a.vendor.matchedMenuName),
              },
              {
                dist: b.dist,
                trustLevel: b.vendor.trustLevel,
                menuMatch: Boolean(b.vendor.matchedMenuName),
              },
            ),
          );
        }

        const trackBRanked: Ranked[] = [];
        for (const row of trackBByPair.values()) {
          const v = accountById.get(row.vendor_id);
          if (!v) continue;
          const matchedCat = (categoriesByVendor.get(v.id) ?? []).find(
            (c) => c.category_id === row.category_id,
          );
          if (!matchedCat) continue;
          trackBRanked.push(buildBusinessResult(v, matchedCat, { dist: null, isPanIndia: true }));
        }
        trackBRanked.sort((a, b) =>
          compareRadarResultsWithMenuMatch(
            {
              dist: a.dist,
              trustLevel: a.vendor.trustLevel,
              menuMatch: Boolean(a.vendor.matchedMenuName),
            },
            {
              dist: b.dist,
              trustLevel: b.vendor.trustLevel,
              menuMatch: Boolean(b.vendor.matchedMenuName),
            },
          ),
        );


        const scoped = mergeRadarTracks(trackARanked, trackBRanked, panIndiaOnly);

        if (isCurrent()) {
          setResultsTruncated(trackAHitCap || trackBHitCap);
          setResults(scoped);
          void supabase.rpc("log_radar_search", {
            p_device_id: getDeviceId(),
            p_result_count: scoped.length,
            p_categories_loaded: categoriesLoaded,
          });
        }
      } catch (e: unknown) {
        if (!opts.silent && isCurrent()) {
          if (isNetworkTimeout(e) || e instanceof NetworkExhaustedError) {
            setNetworkSearchFailed(true);
            setNetworkSearchTimedOut(isNetworkTimeout(e));
          } else if (isNetworkFailure(e)) {
            setNetworkSearchFailed(true);
            setNetworkSearchTimedOut(false);
          } else {
            setError(e instanceof Error ? e.message : s.radar_connection_error);
          }
        }
      } finally {
        // A newer fetch owns the scanning flag now; don't end its spinner early.
        if (!opts.silent && isCurrent()) setScanning(false);
      }
    },
    [coords, coordsTried, term, searchRadiusKm, selectedMode, forcedCategoryId, categories, categoriesLoaded, s.radar_connection_error, s.search_category_unavailable, config.aiCategoryConfidenceThreshold],
  );

  // Run search only when GPS coordinates AND the category lookup are ready.
  // scanning stays true (initial state / requestLocation) while waiting, so
  // the radar spinner covers the whole search instead of flashing "0 results".
  useEffect(() => {
    if (!categoriesLoaded) return;
    if (!coords && searchRadiusKm !== PAN_INDIA_RADIUS_KM) {
      if (coordsTried) setScanning(false);
      return;
    }
    void fetchVendors({ silent: false });
  }, [coords, coordsTried, categoriesLoaded, fetchVendors, searchRadiusKm]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void fetchVendors({ silent: true });
      if (consumeNeighboursDirty()) {
        setNeighboursSyncTick((t) => t + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchVendors]);

  const headline = useMemo(() => {
    if (term) return displayName(term);
    return s.radar_sos_headline;
  }, [term, s.radar_sos_headline]);

  const savedByVendorId = useMemo(() => {
    void neighboursSyncTick;
    return Object.fromEntries(
      results.map(({ vendor }) => [
        vendor.id,
        vendor.isSavedNeighbour || readSessionSaved(vendor.id),
      ]),
    );
  }, [results, neighboursSyncTick]);

  const localResults = useMemo(
    () => results.filter(({ vendor }) => !vendor.isPanIndia),
    [results],
  );
  const panIndiaResults = useMemo(
    () => results.filter(({ vendor }) => vendor.isPanIndia),
    [results],
  );

  const bracketLabel = useMemo(() => {
    const opt = RADAR_BRACKET_OPTIONS.find((o) => o.value === searchRadiusKm);
    if (!opt) return `${searchRadiusKm}${s.radar_km}`;
    const key = opt.labelKey;
    return s[key];
  }, [searchRadiusKm, s]);

  useEffect(() => {
    if (!highlightVendorId || scanning || results.length === 0) return;
    if (!results.some(({ vendor }) => vendor.id === highlightVendorId)) return;
    const el = document.querySelector(
      `[id^="radar-vendor-card-${highlightVendorId}:"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashVendorId(highlightVendorId);
    const t = window.setTimeout(() => setFlashVendorId(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlightVendorId, scanning, results]);

  const locatingView = (
        <div
          data-testid="radar-locating"
          className={cn(
            "bg-page-bg flex flex-col items-center justify-center p-6 text-white relative animate-fade-in",
            locatingFullBleed ? "min-h-screen" : "min-h-[80vh]",
          )}
        >
          {/* Back */}
          <button
            type="button"
            onClick={() => navigate("/")}
            className={cn(
              "absolute top-4 h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted border border-border shadow-sm grid place-items-center",
              locatingFullBleed ? "left-4" : "left-0",
            )}
            aria-label={s.radar_back_home}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          {/* Search Header */}
          <div className="absolute top-12 text-center px-6">
            <h2 className="text-brand text-sm font-bold tracking-widest uppercase mb-2">
              {s.radar_scanning_area}
            </h2>
            <p className="text-lg font-semibold italic capitalize text-foreground">
              {s.radar_finding_nearby}{getCategoryLabel(headline)}…
            </p>
          </div>

          {/* The Radar Core */}
          <div className="relative flex items-center justify-center w-64 h-64">
            <div className="absolute w-full h-full border-2 border-brand-border rounded-full animate-ping shadow-[0_0_20px_rgba(34,197,94,0.3)]" />
            <div className="absolute w-3/4 h-3/4 border-2 border-brand/20 rounded-full animate-[ping_1.5s_linear_infinite]" />
            <div className="absolute w-1/2 h-1/2 border-2 border-brand/10 rounded-full animate-[ping_2s_linear_infinite]" />
            <div className="relative z-10 w-24 h-24 bg-page-bg border-2 border-brand rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.5)]">
              <Shield className="w-10 h-10 text-brand animate-pulse" />
            </div>
          </div>

          {/* Trust Indicator */}
          <div
            data-testid="radar-locating-status"
            className={cn(
              "absolute flex items-center gap-2 text-gray-400 text-sm text-center px-6",
              locatingFullBleed ? "bottom-8" : "bottom-24",
            )}
          >
            <Loader2 className="w-4 h-4 animate-spin text-brand shrink-0" />
            <span>{bracketLabel}</span>
          </div>
        </div>
  );

  if (locatingFullBleed) {
    return locatingView;
  }

  return (
    <AppShell theme="dark">
      <div data-scanning={String(scanning)}>
      {locating ? (
        locatingView
      ) : (
        <>
          <header className="flex items-center justify-between mb-4 animate-fade-up">
            <button
              type="button"
              onClick={() => navigate("/")}
              className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted border border-border grid place-items-center"
              aria-label={s.radar_back_home}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="text-center">
              <p className="text-xs uppercase tracking-[0.3em] text-brand">
                {s.radar_live}
              </p>
              <h1 className="font-display text-lg font-bold capitalize">{term ? getCategoryLabel(term) : headline}</h1>
              {!term && (
                <p className="text-xs text-muted-foreground mt-1 px-2 leading-snug">
                  {s.radar_sos_subtitle}
                </p>
              )}
            </div>
            <NotificationBell />
          </header>

          <div className="mb-3 rounded-2xl border border-surface-border bg-surface p-3 space-y-3">
            <RadarModeSelector selectedMode={selectedMode} onModeChange={handleModeChange} />
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                data-testid="radar-search-input"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder={s.searchPlaceholder}
                className="bg-muted/50 border-surface-border pl-10 pr-3"
              />
            </form>
          </div>

          {modeMismatchHint && (
            <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-2">
              <p className="text-sm text-amber-600 leading-relaxed">
                {s.radar_suggest_mode_mismatch(
                  radarModeDisplayLabel(modeMismatchHint.suggestedMode, s),
                )}
              </p>
              <button
                type="button"
                onClick={handleSwitchToSuggestedMode}
                className="w-full rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-600 text-sm font-semibold h-10 active:scale-[0.99]"
              >
                {s.radar_suggest_mode_switch}
              </button>
            </div>
          )}

          {suggestedCategoryName && (
            <p className="text-center text-sm text-brand mb-2 px-4">
              {s.radar_suggestedCategory(getCategoryLabel(suggestedCategoryName))}
            </p>
          )}

          <div className="relative h-32 w-32 mx-auto mb-3">
            <div className="absolute inset-0 rounded-full border-2 border-brand-border" />
            <div className="absolute inset-3 rounded-full border-2 border-brand/20" />
            <div className="absolute inset-0 grid place-items-center">
              <div className="h-14 w-14 rounded-full bg-page-bg border-2 border-brand grid place-items-center shadow-[0_0_24px_rgba(34,197,94,0.4)]">
                <Shield className="h-6 w-6 text-brand" />
              </div>
            </div>
          </div>

          <p className="text-center text-xs uppercase tracking-[0.25em] text-brand mb-2">
            {scanning ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                {bracketLabel}
              </span>
            ) : (
              <>
                {results.length} {results.length === 1 ? s.radar_match : s.radar_matches}
                {s.radar_found}
              </>
            )}
          </p>
        </>
      )}

      {!locating &&
        !error &&
        !unknownTermBrowse && (
          <div className="flex gap-2 overflow-x-auto px-4 pb-3 mb-1 scrollbar-hide">
            {RADAR_BRACKET_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setSearchRadiusKm(opt.value)}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors active:scale-[0.98]",
                  searchRadiusKm === opt.value
                    ? "border-brand bg-brand/15 text-brand ring-1 ring-brand/30"
                    : "border-surface-border bg-surface text-muted-foreground",
                )}
              >
                {s[opt.labelKey]}
              </button>
            ))}
          </div>
        )}

      {locationBlocked && (
        <div className="rounded-2xl border border-amber-500/40 bg-surface p-6 mt-4 space-y-4 text-center">
          <p className="text-4xl" aria-hidden>
            📍
          </p>
          <p className="font-display text-xl font-semibold text-white">
            {s.radar_location_required_title}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {locationDenied ? s.radar_location_denied_body : s.radar_location_required_body}
          </p>
          {locationDenied ? (
            <button
              type="button"
              onClick={openLocationSettings}
              className="w-full rounded-xl bg-brand text-[#0b1f14] h-12 font-semibold active:scale-[0.98]"
            >
              {s.radar_open_settings}
            </button>
          ) : (
            <button
              type="button"
              onClick={requestLocation}
              className="w-full rounded-xl bg-brand text-[#0b1f14] h-12 font-semibold active:scale-[0.98]"
            >
              {s.radar_retry_location}
            </button>
          )}
        </div>
      )}

      {/* Categories load failure (CRITICAL hang site) */}
      {categoriesNetworkStatus && (
        <NetworkErrorBanner
          status={categoriesNetworkStatus === "timeout" ? "timeout" : "failed"}
          message={
            categoriesNetworkStatus === "timeout"
              ? s.radar_categories_timeout
              : s.home_categories_load_error
          }
          onRetry={() => {
            setCategoriesLoaded(false);
            void loadCategories();
          }}
        />
      )}

      {/* Error */}
      {!locationBlocked && networkSearchFailed && (
        <NetworkErrorBanner
          status={networkSearchTimedOut ? "timeout" : "failed"}
          onRetry={() => void fetchVendors({ silent: false })}
        />
      )}

      {!locationBlocked && error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3 mt-2">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-1" />
          <div>
            <p className="font-semibold text-destructive">{s.radar_connection_error}</p>
            <p className="text-sm text-muted-foreground mt-1 break-words">{error}</p>
          </div>
        </div>
      )}

      {/* Unknown term — browse categories */}
      {!locationBlocked && !scanning && !error && unknownTermBrowse && (
        <section className="mt-4 px-4 pb-8">
          <p className="text-center text-sm text-muted-foreground mb-4 leading-relaxed">
            {s.radar_unknownTerm(term)}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {categories
              .filter((c) => c.service_mode === selectedMode)
              .map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  const qs = new URLSearchParams({
                    q: c.label,
                    mode: c.service_mode,
                  });
                  navigate(`/radar?${qs.toString()}`);
                }}
                className="rounded-xl border border-surface-border bg-surface p-3 flex flex-col items-center gap-1.5 active:scale-[0.98] transition-transform"
              >
                <span className="text-2xl" aria-hidden>
                  {c.emoji}
                </span>
                <span className="text-xs font-semibold text-center leading-tight">
                  {getCategoryLabel(c.label)}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Vendor fetch skeleton */}
      {scanning && !error && (
        <section className="mt-4 pb-4">
          {[0, 1, 2, 3].map((i) => (
            <RadarVendorCardSkeleton key={i} />
          ))}
        </section>
      )}

      {/* Results */}
      {!scanning && !error && results.length > 0 && (
        <section className="mt-2 pb-4">
          <p className="text-center text-xs text-muted-foreground px-4 mb-3">
            {s.radar_delivery_disclaimer}
          </p>
          {(() => {
            const localGrouped = groupRadarResultsByCategory(localResults);
            const panGrouped = groupRadarResultsByCategory(panIndiaResults);
            const renderCard = (
              { vendor, dist }: Ranked,
              i: number,
              opts?: { showPanIndiaBadge?: boolean },
            ) => {
              const cardKey = radarResultKey(
                vendor.id,
                vendor.categories[0]?.category_id ?? "",
              );
              return (
                <div
                  key={cardKey}
                  className={cn(
                    flashVendorId === vendor.id &&
                      "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse rounded-2xl",
                  )}
                >
                  <RadarVendorCard
                    vendor={vendor}
                    radarServiceMode={selectedMode}
                    dist={dist}
                    index={i}
                    userNeed={term}
                    categories={vendor.categories}
                    trustLevel={vendor.trustLevel}
                    menuItems={vendor.menuPreview}
                    matchedMenuName={vendor.matchedMenuName}
                    isSaved={savedByVendorId[vendor.id] ?? false}
                    hasOrdered={vendor.hasActiveOrder}
                    hasFulfilledOrder={vendor.hasFulfilledOrder}
                    fulfilledRequestId={vendor.fulfilledRequestId}
                    displayBrandName={vendor.displayBrandName}
                    showPanIndiaBadge={opts?.showPanIndiaBadge}
                    onOrderCancelled={() => void fetchVendors({ silent: true })}
                  />
                </div>
              );
            };

            let cardIndex = 0;
            return (
              <div className="space-y-3">
                {localGrouped.shouldGroup
                  ? localGrouped.groups.map((group) => (
                      <div
                        key={group.categoryId}
                        className="space-y-3"
                        data-testid={`radar-category-group-${group.categoryId}`}
                      >
                        <p
                          className="px-4 pt-1 pb-0.5 text-xs font-bold uppercase tracking-widest text-brand flex items-center gap-1.5"
                          data-testid="radar-category-group-header"
                        >
                          <span aria-hidden>{group.emoji}</span>
                          <span>{getCategoryLabel(group.label)}</span>
                        </p>
                        {group.items.map((row) =>
                          renderCard(row, cardIndex++),
                        )}
                      </div>
                    ))
                  : localResults.map((row) => renderCard(row, cardIndex++))}

                {!isPanIndiaBracket && panIndiaResults.length > 0 && (
                  <p className="px-4 pt-2 pb-1 text-xs font-bold uppercase tracking-widest text-brand">
                    {s.radar_pan_india_section}
                  </p>
                )}

                {panGrouped.shouldGroup
                  ? panGrouped.groups.map((group) => (
                      <div
                        key={`pan-${group.categoryId}`}
                        className="space-y-3"
                        data-testid={`radar-category-group-pan-${group.categoryId}`}
                      >
                        <p
                          className="px-4 pt-1 pb-0.5 text-xs font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5"
                          data-testid="radar-category-group-header"
                        >
                          <span aria-hidden>{group.emoji}</span>
                          <span>{getCategoryLabel(group.label)}</span>
                        </p>
                        {group.items.map((row) =>
                          renderCard(row, cardIndex++, { showPanIndiaBadge: true }),
                        )}
                      </div>
                    ))
                  : panIndiaResults.map((row) =>
                      renderCard(row, cardIndex++, { showPanIndiaBadge: true }),
                    )}
              </div>
            );
          })()}
          {resultsTruncated && (
            <p
              className="mt-3 text-center text-xs text-muted-foreground leading-relaxed"
              data-testid="radar-results-truncated"
            >
              {s.radar_results_truncated}
            </p>
          )}
          {isPharmacyMedicalSearch(term) && (
            <a
              href="tel:104"
              className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3 text-sm text-brand font-medium active:scale-[0.99] transition-transform"
            >
              <PhoneCall className="h-4 w-4 shrink-0" />
              {s.radar_medical_helpline}
            </a>
          )}
          {isOfficialEmergencyCategory(term) && !isPharmacyMedicalSearch(term) && (
            <GovEmergencyServices term={term} />
          )}
        </section>
      )}

      {/* No results empty state */}
      {!scanning &&
        !error &&
        !unknownTermBrowse &&
        !modeMismatchHint &&
        results.length === 0 &&
        (isOfficialEmergencyCategory(term) ? (
          <div className="px-4 mt-4">
            <EmptyStateFailsafe term={term} />
          </div>
        ) : (
          <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-4">
            <p className="text-center font-display text-xl font-semibold text-white">
              {isPanIndiaBracket
                ? s.radar_no_helpers_area
                : s.radar_no_helpers.replace("{radius}", String(searchRadiusKm))}
            </p>
            {showGovHelpAlongsideRadiusExpand(term) && (
              <div className="pt-2 border-t border-brand/20">
                <GovEmergencyServices term={term} />
              </div>
            )}
          </div>
        ))}
      </div>
    </AppShell>
  );
};

// Critical failsafe when widening to 50 km still returns no private responders.
// Official helplines only for core emergency-style categories; others get a growth message.
const EmptyStateFailsafe = ({ term }: { term: string }) => {
  const { s } = useLanguage();
  const showEmergencyNumbers = isOfficialEmergencyCategory(term);

  if (!showEmergencyNumbers) {
    return (
      <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-5">
        <p className="text-center text-sm text-gray-300 leading-relaxed px-1">
          {s.radar_no_helpers_area}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-4">
      <div className="text-center">
        <p className="font-display text-xl font-semibold text-white">
          {s.radar_no_private}
        </p>
        <p className="text-sm text-gray-400 mt-1">
          {s.radar_official_services}
        </p>
      </div>

      <GovEmergencyServices term={term} defaultOpen />
    </div>
  );
};


// Collapsible government & emergency services panel. Only for category-keyed
// helplines — never defaults to 112 for unrelated searches (e.g. AC repair).
export const GovEmergencyServices = ({
  term,
  defaultOpen = false,
}: {
  term: string;
  /** When true, panel starts expanded (e.g. final 50km failsafe). */
  defaultOpen?: boolean;
}) => {
  const { s } = useLanguage();
  const helpKind = govEmergencyHelpLinesForTerm(term);

  type Line = { label: string; number: string; tagline: string; href: string };
  const lines: Line[] = useMemo(() => {
    if (helpKind === "fire") {
      return [
        {
          label: s.radar_gov_fire_label,
          number: "101",
          tagline: s.radar_gov_fire_tagline,
          href: "tel:101",
        },
      ];
    }
    if (helpKind === "medical") {
      return [
        {
          label: s.radar_gov_ambulance_label,
          number: "108",
          tagline: s.radar_gov_ambulance_tagline,
          href: "tel:108",
        },
      ];
    }
    if (helpKind === "roadside") {
      return [
        {
          label: s.radar_gov_highway_label,
          number: "1033",
          tagline: s.radar_gov_highway_tagline,
          href: "tel:1033",
        },
      ];
    }
    if (helpKind === "security") {
      return [
        {
          label: s.radar_gov_emergency_label,
          number: "112",
          tagline: s.radar_gov_emergency_tagline,
          href: "tel:112",
        },
      ];
    }
    return [];
  }, [
    helpKind,
    s.radar_gov_fire_label,
    s.radar_gov_fire_tagline,
    s.radar_gov_ambulance_label,
    s.radar_gov_ambulance_tagline,
    s.radar_gov_highway_label,
    s.radar_gov_highway_tagline,
    s.radar_gov_emergency_label,
    s.radar_gov_emergency_tagline,
  ]);

  if (lines.length === 0) return null;

  const primary = lines[0];
  const showPoliceSecondary = helpKind === "security" || helpKind === "medical";

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="rounded-2xl border border-destructive/40 bg-surface overflow-hidden">
        <CollapsibleTrigger className="w-full flex items-center justify-between gap-3 p-4 group">
          <div className="flex items-center gap-2 min-w-0">
            <Siren className="h-4 w-4 text-destructive shrink-0" />
            <div className="text-left min-w-0">
              <p className="text-xs uppercase tracking-[0.3em] text-destructive font-bold">
                {s.radar_govt_help}
              </p>
              <p className="text-xs text-gray-400 break-words leading-snug">
                {s.radar_tap_to_open}{primary.number}
              </p>
            </div>
          </div>
          <ChevronDown className="h-4 w-4 text-destructive transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pb-4 space-y-2">
          {lines.map((l) => (
            <a
              key={l.number}
              href={l.href}
              className="flex items-start gap-3 rounded-xl bg-page-bg border border-destructive/30 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
            >
              <div className="h-10 w-10 rounded-lg bg-destructive/15 grid place-items-center shrink-0">
                <PhoneCall className="h-4 w-4 text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white break-words leading-snug">{l.label}</p>
                <p className="text-xs text-gray-400 break-words leading-snug">{l.tagline}</p>
              </div>
              <span className="text-sm font-bold text-destructive shrink-0 pt-0.5">{l.number}</span>
            </a>
          ))}
          {showPoliceSecondary && (
            <a
              href="tel:100"
              className="flex items-start gap-3 rounded-xl bg-page-bg border border-destructive/20 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
            >
              <div className="h-10 w-10 rounded-lg bg-destructive/15 grid place-items-center shrink-0">
                <PhoneCall className="h-4 w-4 text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white break-words leading-snug">{s.radar_local_police}</p>
                <p className="text-xs text-gray-400 break-words leading-snug">
                  {s.radar_police_tagline}
                </p>
              </div>
              <span className="text-sm font-bold text-destructive shrink-0 pt-0.5">100</span>
            </a>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export default RadarSearch;
