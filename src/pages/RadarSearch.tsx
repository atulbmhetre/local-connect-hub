import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
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
import { useAppConfig } from "@/hooks/useAppConfig";
import {
  compareRadarResults,
  computeTrustLevelsByVendor,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";
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
};

type Ranked = { vendor: RadarVendorResult; dist: number | null };

function resolveCategoryIdsForTerm(term: string, categories: Category[]): string[] {
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

/** ~55 km at Indian latitudes; slightly wider than max search radius. */
const BBOX_DELTA_DEG = 0.5;
const GPS_TIMEOUT_MS = 10_000;

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
  const nearRadius = config.radarCityRadiusKm ?? 15;
  const maxRadius = config.radarHighwayRadiusKm ?? 50;
  const midRadius = Math.round((nearRadius + maxRadius) / 2);
  const getCategoryLabel = useCategoryLabel();
  const navigate = useNavigate();
  const location = useLocation();
  const highlightVendorId = (location.state as LocationHighlightState | null)?.highlightVendorId;
  const [flashVendorId, setFlashVendorId] = useState<string | null>(null);
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsTried, setCoordsTried] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [scanning, setScanning] = useState(true);
  /** Active search radius in km (15 â†’ optional 25 / 50). */
  const [searchRadiusKm, setSearchRadiusKm] = useState(nearRadius);
  const [results, setResults] = useState<Ranked[]>([]);
  const [error, setError] = useState<string | null>(null);
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

  const expanded = searchRadiusKm > nearRadius;
  const locating = !coordsTried;
  const locationBlocked = coordsTried && coords == null;

  useLayoutEffect(() => {
    setSearchRadiusKm(nearRadius);
    setSuggestedCategoryName(null);
    setUnknownTermBrowse(false);
    setAmbulanceEmergencyOnly(false);
  }, [term, nearRadius]);

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
      if (!coords) {
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

          let categoryIds = resolveCategoryIdsForTerm(term, categories);
          let aiSuggestedName: string | null = null;

          if (categoryIds.length === 0 && !resolveCanonicalTerm(term)) {
            const result = await invokeSuggestCategory({ description: term });
            const threshold = config.aiCategoryConfidenceThreshold ?? 0.85;
            if (
              result.success &&
              result.outcome === "high_existing" &&
              result.category_id &&
              (result.confidence ?? 0) >= threshold
            ) {
              categoryIds = [result.category_id];
              aiSuggestedName = result.category_name ?? null;
            } else {
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
          const { data: vcRows, error: vcError } = await supabase
            .from("vendor_categories")
            .select("vendor_id")
            .in("category_id", categoryIds)
            .eq("status", "approved");
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

        let q = supabase
          .from("vendors")
          .select("*, verification_status")
          .eq("is_active", true)
          .eq("is_banned", false)
          .eq("profile_status", "complete")
          .gte("latitude", coords.lat - BBOX_DELTA_DEG)
          .lte("latitude", coords.lat + BBOX_DELTA_DEG)
          .gte("longitude", coords.lng - BBOX_DELTA_DEG)
          .lte("longitude", coords.lng + BBOX_DELTA_DEG);

        if (vendorIdFilter) {
          q = q.in("id", vendorIdFilter);
        }

        const { data, error: fetchError } = await q.limit(80);
        if (fetchError) throw fetchError;

        let bboxVendors = (data ?? []).filter(
          (v) =>
            v.latitude != null &&
            v.longitude != null &&
            v.latitude !== 0 &&
            v.longitude !== 0,
        ) as Vendor[];

        if (!term) {
          bboxVendors = bboxVendors.filter(
            (v) => String(v.service_mode ?? "").trim().toLowerCase() === "help",
          );
        }

        const vendorIds = bboxVendors.map((v) => v.id);

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

        const all: Ranked[] = bboxVendors.map((v) => ({
          vendor: {
            ...(v as Vendor),
            categories: categoriesByVendor.get(v.id) ?? [],
            trustLevel: trustByVendor.get(v.id) ?? "Unverified",
            menuPreview: menuByVendor.get(v.id) ?? [],
            hasActiveOrder: activeOrderVendorIds.has(v.id),
            hasFulfilledOrder: fulfilledVendorIds.has(v.id),
            fulfilledRequestId: fulfilledRequestByVendor.get(v.id) ?? null,
            isSavedNeighbour: savedVendorIds.has(v.id),
          },
          dist: distanceKm(coords, { lat: v.latitude!, lng: v.longitude! }),
        }));

        const within = (radius: number) =>
          all.filter((r) => r.dist != null && r.dist <= radius);

        const scoped = within(searchRadiusKm);

        scoped.sort((a, b) =>
          compareRadarResults(
            { dist: a.dist, trustLevel: a.vendor.trustLevel },
            { dist: b.dist, trustLevel: b.vendor.trustLevel },
          ),
        );

        if (isCurrent()) setResults(scoped);
      } catch (e: unknown) {
        if (!opts.silent && isCurrent()) {
          setError(e instanceof Error ? e.message : s.radar_connection_error);
        }
      } finally {
        // A newer fetch owns the scanning flag now; don't end its spinner early.
        if (!opts.silent && isCurrent()) setScanning(false);
      }
    },
    [coords, coordsTried, term, searchRadiusKm, categories, categoriesLoaded, s.radar_connection_error, config.aiCategoryConfidenceThreshold],
  );

  // Run search only when GPS coordinates AND the category lookup are ready.
  // scanning stays true (initial state / requestLocation) while waiting, so
  // the radar spinner covers the whole search instead of flashing "0 results".
  useEffect(() => {
    if (!coords) {
      if (coordsTried) setScanning(false);
      return;
    }
    if (!categoriesLoaded) return;
    void fetchVendors({ silent: false });
  }, [coords, coordsTried, categoriesLoaded, fetchVendors]);

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
              {expanded ? s.radar_expanding_scan : s.radar_scanning_area}
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
            <span>{s.radar_searching_within}{searchRadiusKm}{s.radar_km}</span>
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
                {s.radar_searching_within}
                {searchRadiusKm}
                {s.radar_km}
              </span>
            ) : (
              <>
                {results.length} {results.length === 1 ? s.radar_match : s.radar_matches}
                {s.radar_found}
              </>
            )}
          </p>
          {expanded && results.length > 0 && !scanning && (
            <p className="text-center text-[11px] text-muted-foreground mb-4">
              {s.radar_showing_within}{searchRadiusKm}{s.radar_km}.
            </p>
          )}
        </>
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
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => navigate(`/radar?q=${encodeURIComponent(c.label)}`)}
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
      {!locationBlocked && scanning && !error && (
        <section className="mt-4 pb-4">
          {[0, 1, 2, 3].map((i) => (
            <RadarVendorCardSkeleton key={i} />
          ))}
        </section>
      )}

      {/* Results */}
      {!locationBlocked && !scanning && !error && results.length > 0 && (
        <section className="space-y-3 mt-4 pb-4">
          {results.map(({ vendor, dist }, i) => (
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
          {isPharmacyMedicalSearch(term) && (
            <a
              href="tel:104"
              className="mx-4 flex items-center justify-center gap-2 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3 text-sm text-brand font-medium active:scale-[0.99] transition-transform"
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

      {/* 0 results before max radius: widen only; failsafe comes after max radius if still empty. */}
      {!locationBlocked &&
        !scanning &&
        !error &&
        !unknownTermBrowse &&
        !ambulanceEmergencyOnly &&
        results.length === 0 &&
        searchRadiusKm < maxRadius && (
        <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-4">
          <p className="text-center font-display text-lg font-semibold text-white">
            {s.radar_no_helpers.replace("{radius}", String(searchRadiusKm))}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {searchRadiusKm < midRadius && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(midRadius)}
                className="flex-1 rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_14px_rgba(34,197,94,0.35)]"
              >
                {s.radar_expand_25}
              </button>
            )}
            {searchRadiusKm < maxRadius && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(maxRadius)}
                className="flex-1 rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_14px_rgba(34,197,94,0.35)]"
              >
                {s.radar_expand_50}
              </button>
            )}
          </div>
          {showGovHelpAlongsideRadiusExpand(term) && (
            <div className="pt-2 border-t border-brand/20">
              <GovEmergencyServices term={term} />
            </div>
          )}
        </div>
      )}

      {/* True empty state — no private responders even at max radius. */}
      {!locationBlocked &&
        !scanning &&
        !error &&
        !unknownTermBrowse &&
        !ambulanceEmergencyOnly &&
        results.length === 0 &&
        searchRadiusKm >= maxRadius && (
        <div className="text-center py-12 px-6 mx-4">
          <p className="text-4xl mb-2" aria-hidden>
            🔍
          </p>
          <EmptyStateFailsafe term={term} />
        </div>
      )}
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
const GovEmergencyServices = ({
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
  const lines: Line[] = [];
  if (isFire) {
    lines.push({
      label: "Fire Brigade",
      number: "101",
      tagline: "Fire emergency response",
      href: "tel:101",
    });
  } else if (isMedical) {
    lines.push({
      label: "108 Ambulance",
      number: "108",
      tagline: "Free 24×7 medical & ambulance response",
      href: "tel:108",
    });
  } else if (isRoadside) {
    lines.push({
      label: "1033 National Highway",
      number: "1033",
      tagline: "Highway breakdown & road assistance",
      href: "tel:1033",
    });
  } else {
    lines.push({
      label: "112 National Emergency",
      number: "112",
      tagline: "Police, fire & medical — single line",
      href: "tel:112",
    });
  }

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
