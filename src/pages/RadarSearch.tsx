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
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useLanguage } from "@/lib/language";
import { isNetworkFailure } from "@/lib/withNetworkRetry";
import { useAppConfig } from "@/hooks/useAppConfig";
import {
  compareRadarResults,
  computeTrustLevelsByVendor,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";
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
} from "@/lib/radarVendorFilter";
import {
  FIRE_EMERGENCY_LABELS,
  MEDICAL_EMERGENCY_LABELS,
  ROADSIDE_EMERGENCY_LABELS,
  isOfficialEmergencyCategory,
  isAmbulanceEmergencySearch,
  isPharmacyMedicalSearch,
  resolveCanonicalTerm,
  showGovHelpAlongsideRadiusExpand,
  termForGovEmergencyHelp,
} from "@/lib/categories";

export type RadarMenuItem = {
  name: string;
  price: number;
  unit: string | null;
  is_available: boolean;
};

export type RadarVendorResult = Vendor & {
  categories: { label: string; emoji: string }[];
  trustLevel: TrustLevel;
  /** First 5 available menu items, batch-fetched so cards render complete. */
  menuPreview: RadarMenuItem[];
  hasActiveOrder: boolean;
  hasFulfilledOrder: boolean;
  fulfilledRequestId: string | null;
  isSavedNeighbour: boolean;
  isPanIndia?: boolean;
};

type Ranked = { vendor: RadarVendorResult; dist: number | null };

type RadarMode = "help" | "delivery" | "appointment";

function parseRadarMode(raw: string | null): RadarMode | null {
  const m = raw?.trim().toLowerCase();
  if (m === "help" || m === "delivery" || m === "appointment") return m;
  return null;
}

function resolveAllCategoryIdsForTerm(term: string, categories: Category[]): string[] {
  const resolvedLabel = resolveCanonicalTerm(term);
  if (resolvedLabel) {
    const exact = categories.find(
      (c) => c.label.toLowerCase() === resolvedLabel.toLowerCase(),
    );
    if (exact) return [exact.id];
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

function resolveCategoryIdsForTerm(
  term: string,
  categories: Category[],
  serviceMode: RadarMode,
): string[] {
  const modeCategories = categories.filter((c) => c.service_mode === serviceMode);
  const resolvedLabel = resolveCanonicalTerm(term);
  if (resolvedLabel) {
    const exact = modeCategories.find(
      (c) => c.label.toLowerCase() === resolvedLabel.toLowerCase(),
    );
    if (exact) return [exact.id];
  }
  const t = term.trim().toLowerCase();
  if (!t) return [];
  return modeCategories
    .filter(
      (c) =>
        c.label.toLowerCase().includes(t) ||
        t.includes(c.label.toLowerCase()),
    )
    .map((c) => c.id);
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
            <span className="text-xs font-semibold leading-tight">{s[mode.label]}</span>
            <span
              className={cn(
                "text-[10px] leading-tight text-center",
                selected ? "text-white/80" : "text-muted-foreground",
              )}
            >
              {s[mode.sub]}
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
    is_primary: boolean | null;
    categories: { label: string; emoji: string } | { label: string; emoji: string }[] | null;
  }[],
): Map<string, { label: string; emoji: string }[]> {
  const map = new Map<string, { label: string; emoji: string; is_primary: boolean }[]>();

  for (const row of rows) {
    const cat = row.categories;
    const resolved = Array.isArray(cat) ? cat[0] : cat;
    if (!resolved?.label) continue;

    const list = map.get(row.vendor_id) ?? [];
    list.push({
      label: resolved.label,
      emoji: resolved.emoji ?? "✨",
      is_primary: row.is_primary === true,
    });
    map.set(row.vendor_id, list);
  }

  const out = new Map<string, { label: string; emoji: string }[]>();
  for (const [vendorId, list] of map) {
    list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
    out.set(
      vendorId,
      list.map(({ label, emoji }) => ({ label, emoji })),
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
      className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-4 animate-pulse"
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
  const [categories, setCategories] = useState<Category[]>([]);
  /**
   * Search must not run before the categories lookup resolves: with an empty
   * categories list the term resolves to zero ids and the search would
   * early-return setResults([]), flashing "0 results" before the real fetch.
   */
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  /** Bumped when neighbours_dirty is consumed so isSaved re-reads session flags. */
  const [neighboursSyncTick, setNeighboursSyncTick] = useState(0);
  const [suggestedCategoryName, setSuggestedCategoryName] = useState<string | null>(null);
  const [unknownTermBrowse, setUnknownTermBrowse] = useState(false);
  const [ambulanceEmergencyOnly, setAmbulanceEmergencyOnly] = useState(false);
  /** Monotonic id so a stale in-flight fetch can never overwrite newer results. */
  const fetchSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode, is_active, sort_order")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data, error: catError }) => {
        if (cancelled) return;
        if (catError) {
          console.error("radar categories load", catError);
          setCategories([]);
          setCategoriesLoaded(true);
          return;
        }
        setCategories((data ?? []) as Category[]);
        setCategoriesLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isPanIndiaBracket = searchRadiusKm === PAN_INDIA_RADIUS_KM;
  const locating = !coordsTried;
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
    setAmbulanceEmergencyOnly(false);
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
      setAmbulanceEmergencyOnly(false);
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
    setAmbulanceEmergencyOnly(false);

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
      }
      try {
        let vendorIdFilter: string[] | null = null;
        if (term) {
          if (isAmbulanceEmergencySearch(term)) {
            if (isCurrent()) {
              setResults([]);
              setAmbulanceEmergencyOnly(true);
              setUnknownTermBrowse(false);
              setSuggestedCategoryName(null);
            }
            return;
          }

          if (isCurrent()) setAmbulanceEmergencyOnly(false);
          setModeMismatchHint(null);

          let categoryIds = resolveCategoryIdsForTerm(term, categories, selectedMode);
          let aiSuggestedName: string | null = null;

          if (
            categoryIds.length === 0 &&
            forcedCategoryId &&
            categories.find((c) => c.id === forcedCategoryId)?.service_mode === selectedMode
          ) {
            categoryIds = [forcedCategoryId];
            aiSuggestedName =
              categories.find((c) => c.id === forcedCategoryId)?.label ?? null;
          }

          if (categoryIds.length === 0 && !resolveCanonicalTerm(term)) {
            const result = await invokeSuggestCategory({ description: term });
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
          const { data: vcRows, error: vcError } = await supabase
            .from("vendor_categories")
            .select("vendor_id")
            .in("category_id", categoryIds)
            .eq("status", "approved")
            .eq("service_mode", selectedMode);
          if (vcError) throw vcError;
          vendorIdFilter = [...new Set((vcRows ?? []).map((row) => row.vendor_id))];
          if (vendorIdFilter.length === 0) {
            if (isCurrent()) setResults([]);
            return;
          }
        } else if (isCurrent()) {
          setAmbulanceEmergencyOnly(false);
          setUnknownTermBrowse(false);
          setSuggestedCategoryName(null);
        }

        /** Empty browse: include vendors with an approved category row for this tab's mode. */
        let multiModeVendorIds: string[] | null = null;
        if (!term) {
          const { data: vcModeRows, error: vcModeError } = await supabase
            .from("vendor_categories")
            .select("vendor_id")
            .eq("status", "approved")
            .eq("service_mode", selectedMode);
          if (vcModeError) throw vcModeError;
          const ids = [...new Set((vcModeRows ?? []).map((row) => row.vendor_id))];
          if (ids.length > 0) multiModeVendorIds = ids;
        }

        const categoryModeSearch = vendorIdFilter !== null;
        const emptyBrowseMultiMode = !term && multiModeVendorIds !== null;

        const bboxDeltaDeg = Math.max(BBOX_DELTA_DEG, userBracket / KM_PER_DEG_LAT);

        let qTrackA = panIndiaOnly || !coords
          ? null
          : supabase
              .from("vendors")
              .select("*, verification_status")
              .eq("is_banned", false)
              .eq("profile_status", "complete")
              .lt("service_radius_km", PAN_INDIA_RADIUS_KM)
              .gte("latitude", coords.lat - bboxDeltaDeg)
              .lte("latitude", coords.lat + bboxDeltaDeg)
              .gte("longitude", coords.lng - bboxDeltaDeg)
              .lte("longitude", coords.lng + bboxDeltaDeg);

        /** Wide-radius vendors may sit outside the customer bbox but still cover the customer. */
        let qTrackAWide =
          panIndiaOnly || !coords
            ? null
            : supabase
                .from("vendors")
                .select("*, verification_status")
                .eq("is_banned", false)
                .eq("profile_status", "complete")
                .gte("service_radius_km", userBracket)
                .lt("service_radius_km", PAN_INDIA_RADIUS_KM);

        /** Empty browse: vendors whose primary service_mode differs but have a category row for this tab. */
        let qTrackAMultiMode =
          panIndiaOnly || !coords || !emptyBrowseMultiMode
            ? null
            : supabase
                .from("vendors")
                .select("*, verification_status")
                .eq("is_banned", false)
                .eq("profile_status", "complete")
                .lt("service_radius_km", PAN_INDIA_RADIUS_KM)
                .gte("latitude", coords.lat - bboxDeltaDeg)
                .lte("latitude", coords.lat + bboxDeltaDeg)
                .gte("longitude", coords.lng - bboxDeltaDeg)
                .lte("longitude", coords.lng + bboxDeltaDeg)
                .in("id", multiModeVendorIds!);

        let qTrackAWideMultiMode =
          panIndiaOnly || !coords || !emptyBrowseMultiMode
            ? null
            : supabase
                .from("vendors")
                .select("*, verification_status")
                .eq("is_banned", false)
                .eq("profile_status", "complete")
                .gte("service_radius_km", userBracket)
                .lt("service_radius_km", PAN_INDIA_RADIUS_KM)
                .in("id", multiModeVendorIds!);

        if (qTrackA && !categoryModeSearch) {
          qTrackA = qTrackA.eq("service_mode", selectedMode);
        }

        if (qTrackAWide && !categoryModeSearch) {
          qTrackAWide = qTrackAWide.eq("service_mode", selectedMode);
        }

        if (qTrackA && selectedMode === "help") {
          qTrackA = qTrackA.eq("is_active", true);
        }

        if (qTrackAWide && selectedMode === "help") {
          qTrackAWide = qTrackAWide.eq("is_active", true);
        }

        if (qTrackAMultiMode && selectedMode === "help") {
          qTrackAMultiMode = qTrackAMultiMode.eq("is_active", true);
        }

        if (qTrackAWideMultiMode && selectedMode === "help") {
          qTrackAWideMultiMode = qTrackAWideMultiMode.eq("is_active", true);
        }

        if (qTrackA && vendorIdFilter) {
          qTrackA = qTrackA.in("id", vendorIdFilter);
        }

        if (qTrackAWide && vendorIdFilter) {
          qTrackAWide = qTrackAWide.in("id", vendorIdFilter);
        }

        if (qTrackAMultiMode && vendorIdFilter) {
          qTrackAMultiMode = qTrackAMultiMode.in("id", vendorIdFilter);
        }

        if (qTrackAWideMultiMode && vendorIdFilter) {
          qTrackAWideMultiMode = qTrackAWideMultiMode.in("id", vendorIdFilter);
        }

        let qTrackB = supabase
          .from("vendors")
          .select("*, verification_status")
          .eq("is_banned", false)
          .eq("profile_status", "complete")
          .eq("service_radius_km", PAN_INDIA_RADIUS_KM);

        if (!categoryModeSearch) {
          qTrackB = qTrackB.eq("service_mode", selectedMode);
        }

        if (selectedMode === "help") {
          qTrackB = qTrackB.eq("is_active", true);
        }

        if (vendorIdFilter) {
          qTrackB = qTrackB.in("id", vendorIdFilter);
        }

        let qTrackBMultiMode = emptyBrowseMultiMode
          ? supabase
              .from("vendors")
              .select("*, verification_status")
              .eq("is_banned", false)
              .eq("profile_status", "complete")
              .eq("service_radius_km", PAN_INDIA_RADIUS_KM)
              .in("id", multiModeVendorIds!)
          : null;

        if (qTrackBMultiMode && selectedMode === "help") {
          qTrackBMultiMode = qTrackBMultiMode.eq("is_active", true);
        }

        if (qTrackBMultiMode && vendorIdFilter) {
          qTrackBMultiMode = qTrackBMultiMode.in("id", vendorIdFilter);
        }

        const [trackAResult, trackAWideResult, trackAMultiModeResult, trackAWideMultiModeResult, trackBResult, trackBMultiModeResult] =
          await Promise.all([
          qTrackA ? qTrackA.limit(TRACK_A_LIMIT) : Promise.resolve({ data: [], error: null }),
          qTrackAWide
            ? qTrackAWide.limit(TRACK_A_LIMIT)
            : Promise.resolve({ data: [], error: null }),
          qTrackAMultiMode
            ? qTrackAMultiMode.limit(TRACK_A_LIMIT)
            : Promise.resolve({ data: [], error: null }),
          qTrackAWideMultiMode
            ? qTrackAWideMultiMode.limit(TRACK_A_LIMIT)
            : Promise.resolve({ data: [], error: null }),
          qTrackB.limit(TRACK_B_LIMIT),
          qTrackBMultiMode
            ? qTrackBMultiMode.limit(TRACK_B_LIMIT)
            : Promise.resolve({ data: [], error: null }),
        ]);

        if (trackAResult.error) throw trackAResult.error;
        if (trackAWideResult.error) throw trackAWideResult.error;
        if (trackAMultiModeResult.error) throw trackAMultiModeResult.error;
        if (trackAWideMultiModeResult.error) throw trackAWideMultiModeResult.error;
        if (trackBResult.error) throw trackBResult.error;
        if (trackBMultiModeResult.error) throw trackBMultiModeResult.error;

        const trackAVendorById = new Map<string, Vendor>();
        for (const row of [
          ...(trackAResult.data ?? []),
          ...(trackAWideResult.data ?? []),
          ...(trackAMultiModeResult.data ?? []),
          ...(trackAWideMultiModeResult.data ?? []),
        ]) {
          trackAVendorById.set(row.id, row as Vendor);
        }

        let trackAVendors = [...trackAVendorById.values()].filter(
          (v) =>
            v.latitude != null &&
            v.longitude != null &&
            v.latitude !== 0 &&
            v.longitude !== 0,
        ) as Vendor[];

        let trackBVendors = (trackBResult.data ?? []) as Vendor[];
        if (trackBMultiModeResult.data?.length) {
          const trackBById = new Map(trackBVendors.map((v) => [v.id, v]));
          for (const row of trackBMultiModeResult.data) {
            trackBById.set(row.id, row as Vendor);
          }
          trackBVendors = [...trackBById.values()];
        }

        trackAVendors = excludeOfflineHelpVendors(trackAVendors);
        trackBVendors = excludeOfflineHelpVendors(trackBVendors);

        const vendorIds = [
          ...new Set([
            ...trackAVendors.map((v) => v.id),
            ...trackBVendors.map((v) => v.id),
          ]),
        ];

        let verificationRows: VendorVerificationRow[] = [];
        let categoriesByVendor = new Map<string, { label: string; emoji: string }[]>();
        const menuByVendor = new Map<string, RadarMenuItem[]>();
        let activeOrderVendorIds = new Set<string>();
        let fulfilledVendorIds = new Set<string>();
        const fulfilledRequestByVendor = new Map<string, string>();
        let savedVendorIds = new Set<string>();

        if (vendorIds.length > 0) {
          const deviceId = getDeviceId();
          const userPhone = getUserPhone();
          let savedQuery = supabase
            .from("saved_vendors")
            .select("vendor_id")
            .in("vendor_id", vendorIds);
          savedQuery =
            userPhone != null
              ? savedQuery.eq("user_phone", userPhone)
              : savedQuery.eq("device_id", deviceId);

          let activeQuery = supabase
            .from("requests")
            .select("vendor_id")
            .in("vendor_id", vendorIds)
            .in("status", ["sent", "seen"]);
          activeQuery =
            userPhone != null
              ? activeQuery.or(`user_phone.eq.${userPhone},device_id.eq.${deviceId}`)
              : activeQuery.eq("device_id", deviceId);

          let fulfilledQuery = supabase
            .from("requests")
            .select("id, vendor_id")
            .in("vendor_id", vendorIds)
            .eq("status", "fulfilled");
          fulfilledQuery =
            userPhone != null
              ? fulfilledQuery.or(`user_phone.eq.${userPhone},device_id.eq.${deviceId}`)
              : fulfilledQuery.eq("device_id", deviceId);

          const [verResult, vcResult, menuResult, activeResult, fulfilledResult, savedResult] =
            await Promise.all([
              supabase
                .from("vendor_verification")
                .select("vendor_id, check_type, status, is_latest")
                .in("vendor_id", vendorIds)
                .eq("is_latest", true),
              supabase
                .from("vendor_categories")
                .select("vendor_id, is_primary, categories(label, emoji)")
                .in("vendor_id", vendorIds)
                .eq("status", "approved"),
              supabase
                .from("vendor_menu_items")
                .select("vendor_id, name, price, unit, is_available")
                .in("vendor_id", vendorIds)
                .eq("is_available", true)
                .order("sort_order", { ascending: true }),
              activeQuery,
              fulfilledQuery,
              savedQuery,
            ]);

          if (verResult.error) throw verResult.error;
          if (vcResult.error) throw vcResult.error;
          // Menu/order/saved data only enrich the cards; tolerate failures.

          verificationRows = (verResult.data ?? []) as VendorVerificationRow[];
          categoriesByVendor = buildVendorCategoriesMap(
            (vcResult.data ?? []) as Parameters<typeof buildVendorCategoriesMap>[0],
          );

          for (const row of menuResult.data ?? []) {
            const list = menuByVendor.get(row.vendor_id) ?? [];
            // Rows arrive sorted by sort_order; keep the first 5 per vendor
            // to match the old per-card .limit(5) preview behaviour.
            if (list.length < 5) {
              list.push({
                name: row.name,
                price: row.price,
                unit: row.unit,
                is_available: row.is_available,
              });
              menuByVendor.set(row.vendor_id, list);
            }
          }
          activeOrderVendorIds = new Set((activeResult.data ?? []).map((r) => r.vendor_id));
          for (const row of fulfilledResult.data ?? []) {
            fulfilledVendorIds.add(row.vendor_id);
            if (!fulfilledRequestByVendor.has(row.vendor_id)) {
              fulfilledRequestByVendor.set(row.vendor_id, row.id);
            }
          }
          savedVendorIds = new Set((savedResult.data ?? []).map((r) => r.vendor_id));
        }

        const trustByVendor = computeTrustLevelsByVendor(vendorIds, verificationRows);

        const buildVendorResult = (
          v: Vendor,
          extras: {
            dist: number | null;
            isPanIndia?: boolean;
          },
        ): Ranked => ({
          vendor: {
            ...(v as Vendor),
            categories: categoriesByVendor.get(v.id) ?? [],
            trustLevel: trustByVendor.get(v.id) ?? "Unverified",
            menuPreview: menuByVendor.get(v.id) ?? [],
            hasActiveOrder: activeOrderVendorIds.has(v.id),
            hasFulfilledOrder: fulfilledVendorIds.has(v.id),
            fulfilledRequestId: fulfilledRequestByVendor.get(v.id) ?? null,
            isSavedNeighbour: savedVendorIds.has(v.id),
            isPanIndia: extras.isPanIndia,
          },
          dist: extras.dist,
        });

        const trackARanked: Ranked[] = [];
        if (!panIndiaOnly && coords) {
          for (const v of trackAVendors) {
            if (isPanIndiaServiceRadius(v.service_radius_km)) continue;
            const dist = distanceKm(coords, { lat: v.latitude!, lng: v.longitude! });
            if (!passesTrackARadiusFilter(dist, userBracket, v.service_radius_km)) continue;
            trackARanked.push(buildVendorResult(v, { dist }));
          }
          trackARanked.sort((a, b) =>
            compareRadarResults(
              { dist: a.dist, trustLevel: a.vendor.trustLevel },
              { dist: b.dist, trustLevel: b.vendor.trustLevel },
            ),
          );
        }

        const trackBRanked: Ranked[] = trackBVendors.map((v) =>
          buildVendorResult(v, { dist: null, isPanIndia: true }),
        );
        trackBRanked.sort((a, b) =>
          compareRadarResults(
            { dist: a.dist, trustLevel: a.vendor.trustLevel },
            { dist: b.dist, trustLevel: b.vendor.trustLevel },
          ),
        );

        const scoped = mergeRadarTracks(trackARanked, trackBRanked, panIndiaOnly);

        if (isCurrent()) setResults(scoped);
      } catch (e: unknown) {
        if (!opts.silent && isCurrent()) {
          if (isNetworkFailure(e)) {
            setNetworkSearchFailed(true);
          } else {
            setError(e instanceof Error ? e.message : s.radar_connection_error);
          }
        }
      } finally {
        // A newer fetch owns the scanning flag now; don't end its spinner early.
        if (!opts.silent && isCurrent()) setScanning(false);
      }
    },
    [coords, coordsTried, term, searchRadiusKm, selectedMode, forcedCategoryId, categories, categoriesLoaded, s.radar_connection_error, config.aiCategoryConfidenceThreshold],
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
    const el = document.getElementById(`radar-vendor-card-${highlightVendorId}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashVendorId(highlightVendorId);
    const t = window.setTimeout(() => setFlashVendorId(null), 2500);
    return () => window.clearTimeout(t);
  }, [highlightVendorId, scanning, results]);

  return (
    <AppShell theme="dark">
      {locating ? (
        <div className="min-h-[80vh] bg-page-bg flex flex-col items-center justify-center p-6 text-white relative animate-fade-in">
          {/* Back */}
          <button
            type="button"
            onClick={() => navigate("/")}
            className="absolute top-4 left-0 h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted border border-border shadow-sm grid place-items-center"
            aria-label={s.radar_back_home}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          {/* Search Header */}
          <div className="absolute top-12 text-center px-6">
            <h2 className="text-brand text-sm font-bold tracking-widest uppercase mb-2">
              {s.radar_scanning_area}
            </h2>
            <p className="text-2xl font-semibold italic capitalize text-foreground">
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
          <div className="absolute bottom-24 flex items-center gap-2 text-gray-400 text-sm text-center px-6">
            <Loader2 className="w-4 h-4 animate-spin text-brand shrink-0" />
            <span>{bracketLabel}</span>
          </div>
        </div>
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
              <p className="text-[10px] uppercase tracking-[0.3em] text-brand">
                {s.radar_live}
              </p>
              <h1 className="font-display text-lg font-bold capitalize">{term ? getCategoryLabel(term) : headline}</h1>
              {!term && (
                <p className="text-[11px] text-muted-foreground mt-1 px-2 leading-snug">
                  {s.radar_sos_subtitle}
                </p>
              )}
            </div>
            <NotificationBell />
          </header>

          <div className="mx-4 mb-3 rounded-2xl border border-surface-border bg-surface p-3 space-y-3">
            <RadarModeSelector selectedMode={selectedMode} onModeChange={handleModeChange} />
            <form onSubmit={handleSearchSubmit} className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <input
                data-testid="radar-search-input"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                placeholder={s.searchPlaceholder}
                className="w-full bg-muted/50 border border-surface-border rounded-xl pl-10 pr-3 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
            </form>
          </div>

          {modeMismatchHint && (
            <div className="mx-4 mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-2">
              <p className="text-sm text-amber-600 leading-relaxed">
                {s.radar_suggest_mode_mismatch(
                  radarModeDisplayLabel(modeMismatchHint.suggestedMode, s),
                )}
              </p>
              <button
                type="button"
                onClick={handleSwitchToSuggestedMode}
                className="w-full rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-600 text-sm font-semibold py-2.5 active:scale-[0.99]"
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
        !ambulanceEmergencyOnly &&
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
          <p className="font-display text-lg font-semibold text-white">
            {s.radar_location_required_title}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {locationDenied ? s.radar_location_denied_body : s.radar_location_required_body}
          </p>
          {locationDenied ? (
            <button
              type="button"
              onClick={openLocationSettings}
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
            >
              {s.radar_open_settings}
            </button>
          ) : (
            <button
              type="button"
              onClick={requestLocation}
              className="w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98]"
            >
              {s.radar_retry_location}
            </button>
          )}
        </div>
      )}

      {/* Error */}
      {!locationBlocked && networkSearchFailed && (
        <NetworkErrorBanner
          status="failed"
          onRetry={() => void fetchVendors({ silent: false })}
        />
      )}

      {!locationBlocked && error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3 mt-2">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-destructive">{s.radar_connection_error}</p>
            <p className="text-sm text-muted-foreground mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}

      {/* Ambulance / accident / emergency — 108 only, no vendor search */}
      {!locationBlocked && !scanning && !error && ambulanceEmergencyOnly && (
        <section className="mt-4 px-4 pb-4">
          <GovEmergencyServices term={term} defaultOpen />
        </section>
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
          <p className="text-center text-[11px] text-muted-foreground px-4 mb-3">
            {s.radar_delivery_disclaimer}
          </p>
          <div className="space-y-3">
            {localResults.map(({ vendor, dist }, i) => (
              <div
                key={vendor.id}
                id={`radar-vendor-card-${vendor.id}`}
                className={cn(
                  flashVendorId === vendor.id &&
                    "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse rounded-2xl",
                )}
              >
                <RadarVendorCard
                  vendor={vendor}
                  dist={dist}
                  index={i}
                  userNeed={term}
                  categories={vendor.categories}
                  trustLevel={vendor.trustLevel}
                  menuItems={vendor.menuPreview}
                  isSaved={savedByVendorId[vendor.id] ?? false}
                  hasOrdered={vendor.hasActiveOrder}
                  hasFulfilledOrder={vendor.hasFulfilledOrder}
                  fulfilledRequestId={vendor.fulfilledRequestId}
                  onOrderCancelled={() => void fetchVendors({ silent: true })}
                />
              </div>
            ))}
            {!isPanIndiaBracket && panIndiaResults.length > 0 && (
              <p className="px-4 pt-2 pb-1 text-xs font-bold uppercase tracking-widest text-brand">
                {s.radar_pan_india_section}
              </p>
            )}
            {panIndiaResults.map(({ vendor, dist }, i) => (
              <div
                key={vendor.id}
                id={`radar-vendor-card-${vendor.id}`}
                className={cn(
                  flashVendorId === vendor.id &&
                    "ring-2 ring-amber-500 border-amber-500/50 bg-amber-500/10 animate-pulse rounded-2xl",
                )}
              >
                <RadarVendorCard
                  vendor={vendor}
                  dist={dist}
                  index={localResults.length + i}
                  userNeed={term}
                  categories={vendor.categories}
                  trustLevel={vendor.trustLevel}
                  menuItems={vendor.menuPreview}
                  isSaved={savedByVendorId[vendor.id] ?? false}
                  hasOrdered={vendor.hasActiveOrder}
                  hasFulfilledOrder={vendor.hasFulfilledOrder}
                  fulfilledRequestId={vendor.fulfilledRequestId}
                  showPanIndiaBadge
                  onOrderCancelled={() => void fetchVendors({ silent: true })}
                />
              </div>
            ))}
          </div>
          {isPharmacyMedicalSearch(term) && (
            <a
              href="tel:104"
              className="mx-4 mt-3 flex items-center justify-center gap-2 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3 text-sm text-brand font-medium active:scale-[0.99] transition-transform"
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
        !ambulanceEmergencyOnly &&
        !modeMismatchHint &&
        results.length === 0 &&
        (isOfficialEmergencyCategory(term) ? (
          <div className="px-4 mt-4">
            <EmptyStateFailsafe term={term} />
          </div>
        ) : (
          <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-4 mx-4">
            <p className="text-center font-display text-lg font-semibold text-white">
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
        <p className="font-display text-lg font-semibold text-white">
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


// Collapsible government & emergency services panel rendered below the
// vendor results. Primary number shifts based on the searched category:
// Fire â†’ 101, Medical â†’ 108, Roadside â†’ 1033, Security/Default â†’ 112.
export const GovEmergencyServices = ({
  term,
  defaultOpen = false,
}: {
  term: string;
  /** When true, panel starts expanded (e.g. final 50km failsafe). */
  defaultOpen?: boolean;
}) => {
  const { s } = useLanguage();
  const resolved = resolveCanonicalTerm(termForGovEmergencyHelp(term));
  const isMedical = resolved ? MEDICAL_EMERGENCY_LABELS.has(resolved) : false;
  const isRoadside = resolved ? ROADSIDE_EMERGENCY_LABELS.has(resolved) : false;
  const isFire = resolved ? FIRE_EMERGENCY_LABELS.has(resolved) : false;

  type Line = { label: string; number: string; tagline: string; href: string };
  const lines: Line[] = useMemo(() => {
    if (isFire) {
      return [
        {
          label: s.radar_gov_fire_label,
          number: "101",
          tagline: s.radar_gov_fire_tagline,
          href: "tel:101",
        },
      ];
    }
    if (isMedical) {
      return [
        {
          label: s.radar_gov_ambulance_label,
          number: "108",
          tagline: s.radar_gov_ambulance_tagline,
          href: "tel:108",
        },
      ];
    }
    if (isRoadside) {
      return [
        {
          label: s.radar_gov_highway_label,
          number: "1033",
          tagline: s.radar_gov_highway_tagline,
          href: "tel:1033",
        },
      ];
    }
    return [
      {
        label: s.radar_gov_emergency_label,
        number: "112",
        tagline: s.radar_gov_emergency_tagline,
        href: "tel:112",
      },
    ];
  }, [
    isFire,
    isMedical,
    isRoadside,
    s.radar_gov_fire_label,
    s.radar_gov_fire_tagline,
    s.radar_gov_ambulance_label,
    s.radar_gov_ambulance_tagline,
    s.radar_gov_highway_label,
    s.radar_gov_highway_tagline,
    s.radar_gov_emergency_label,
    s.radar_gov_emergency_tagline,
  ]);

  const primary = lines[0];

  return (
    <Collapsible defaultOpen={defaultOpen}>
      <div className="rounded-2xl border border-destructive/40 bg-surface overflow-hidden">
        <CollapsibleTrigger className="w-full flex items-center justify-between gap-3 p-4 group">
          <div className="flex items-center gap-2 min-w-0">
            <Siren className="h-4 w-4 text-destructive shrink-0" />
            <div className="text-left min-w-0">
              <p className="text-[10px] uppercase tracking-[0.3em] text-destructive font-bold">
                {s.radar_govt_help}
              </p>
              <p className="text-xs text-gray-400 truncate">
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
              className="flex items-center gap-3 rounded-xl bg-page-bg border border-destructive/30 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
            >
              <div className="h-10 w-10 rounded-lg bg-destructive/15 grid place-items-center shrink-0">
                <PhoneCall className="h-4 w-4 text-destructive" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">{l.label}</p>
                <p className="text-[11px] text-gray-400 truncate">{l.tagline}</p>
              </div>
              <span className="text-sm font-bold text-destructive">{l.number}</span>
            </a>
          ))}
          <a
            href="tel:100"
            className="flex items-center gap-3 rounded-xl bg-page-bg border border-destructive/20 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
          >
            <div className="h-10 w-10 rounded-lg bg-destructive/15 grid place-items-center shrink-0">
              <PhoneCall className="h-4 w-4 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">{s.radar_local_police}</p>
              <p className="text-[11px] text-gray-400 truncate">
                {s.radar_police_tagline}
              </p>
            </div>
            <span className="text-sm font-bold text-destructive">100</span>
          </a>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export default RadarSearch;
