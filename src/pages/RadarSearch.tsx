import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { NotificationBell } from "@/components/NotificationBell";
import {
  ArrowLeft,
  MapPin,
  AlertTriangle,
  Shield,
  ShieldAlert,
  Loader2,
  Clock,
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
} from "@/lib/supabase";
import {
  RadarVendorCard,
  consumeNeighboursDirty,
  readSessionSaved,
} from "@/components/RadarVendorCard";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useLanguage } from "@/lib/language";
import {
  compareRadarResults,
  computeTrustLevelsByVendor,
  type TrustLevel,
  type VendorVerificationRow,
} from "@/lib/trustLevel";

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
  isSavedNeighbour: boolean;
};

type Ranked = { vendor: RadarVendorResult; dist: number | null };

// Strict resolver mirrors Home: maps free-text/voice to canonical category labels.
// TODO Phase 2: Replace KNOWN_CATEGORIES with DB lookup from categories table
// Alias resolution should be driven by a categories_aliases table in Supabase
// so new vendor categories get searchable without code changes
const KNOWN_CATEGORIES: { label: string; aliases: string[] }[] = [
  { label: "Mechanic", aliases: ["mechanic", "garage", "repair", "engine", "car repair", "bike repair"] },
  { label: "Towing", aliases: ["towing", "tow", "tow truck", "breakdown", "crane"] },
  { label: "Tyre Service", aliases: ["tyre", "tire", "puncture", "flat tyre", "wheel"] },
  { label: "Key Maker", aliases: ["key", "keymaker", "locksmith", "duplicate key", "lock"] },
  { label: "Ambulance", aliases: ["ambulance", "emergency", "108"] },
  {
    label: "Fire Brigade",
    aliases: ["fire station", "fire brigade", "agni shaman", "agnishaman", "fire emergency"],
  },
  { label: "Pharmacy", aliases: ["pharmacy", "medical", "medicine", "chemist", "drug store", "tablet"] },
  { label: "Nursing", aliases: ["nursing", "nurse", "home care", "caretaker", "patient care"] },
  { label: "Plumber", aliases: ["plumber", "plumbing", "leak", "pipe", "tap", "water"] },
  { label: "Electrician", aliases: ["electrician", "electric", "wiring", "current", "fuse", "power"] },
  { label: "Security", aliases: ["security", "guard", "watchman", "bouncer"] },
];

function resolveCategory(term: string): string | null {
  const t = term.toLowerCase().trim();
  for (const c of KNOWN_CATEGORIES) {
    if (c.label.toLowerCase() === t) return c.label;
    if (c.aliases.some((a) => t.includes(a))) return c.label;
  }
  return null;
}

function resolveCategoryIdsForTerm(term: string, categories: Category[]): string[] {
  const resolvedLabel = resolveCategory(term);
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

/** Default geofence; user can widen to 25 km or 50 km before the failsafe UI. */
const NEAR_RADIUS_KM = 15;
const MAX_RADIUS_KM = 50;
/** ~55 km at Indian latitudes; slightly wider than max 50 km search radius. */
const BBOX_DELTA_DEG = 0.5;
const GPS_TIMEOUT_MS = 10_000;

const MEDICAL = new Set(["Ambulance", "Pharmacy", "Nursing"]);
const ROADSIDE = new Set(["Mechanic", "Towing", "Tyre Service"]);
const FIRE = new Set(["Fire Brigade"]);

/** Only these searches show official emergency helplines in EmptyStateFailsafe. */
const OFFICIAL_EMERGENCY_CATEGORIES = new Set([
  "Ambulance",
  "Nursing",
  "Pharmacy",
  "Mechanic",
  "Towing",
  "Tyre Service",
  "Fire Brigade",
]);

function isOfficialEmergencyCategory(term: string): boolean {
  const raw = term.trim().toLowerCase();
  if (/\bhospitals?\b/.test(raw)) return true;
  if (raw === "medical") return true;
  const resolved = resolveCategory(term);
  if (resolved && OFFICIAL_EMERGENCY_CATEGORIES.has(resolved)) return true;
  const t = term.trim().toLowerCase();
  if (!t) return false;
  for (const label of OFFICIAL_EMERGENCY_CATEGORIES) {
    if (label.toLowerCase() === t) return true;
  }
  return false;
}

/** Map vague medical searches to a category that triggers 108 in govt help UI. */
function termForGovEmergencyHelp(term: string): string {
  const t = term.trim().toLowerCase();
  if (/\bhospitals?\b/.test(t)) return "Ambulance";
  if (t === "medical") return "Ambulance";
  return term;
}

/** When radar is empty before 50km, show official lines + radius expand (not only after max radius). */
function showGovHelpAlongsideRadiusExpand(term: string): boolean {
  const t = term.trim().toLowerCase();
  if (/\bhospitals?\b/.test(t)) return true;
  if (t === "medical") return true;
  const r = resolveCategory(term);
  if (!r) return false;
  return r === "Fire Brigade" || r === "Ambulance" || r === "Nursing";
}

const RadarSearch = () => {
  const { s } = useLanguage();
  const getCategoryLabel = useCategoryLabel();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsTried, setCoordsTried] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [scanning, setScanning] = useState(true);
  /** Active search radius in km (15 â†’ optional 25 / 50). */
  const [searchRadiusKm, setSearchRadiusKm] = useState(NEAR_RADIUS_KM);
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

  const expanded = searchRadiusKm > NEAR_RADIUS_KM;
  const locating = !coordsTried;
  const locationBlocked = coordsTried && coords == null;

  useLayoutEffect(() => {
    setSearchRadiusKm(NEAR_RADIUS_KM);
  }, [term]);

  const requestLocation = useCallback(() => {
    setCoordsTried(false);
    setCoords(null);
    setLocationDenied(false);
    setScanning(true);
    setError(null);
    setResults([]);

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
        if (!opts.silent) {
          await new Promise((r) => setTimeout(r, 900));
        }

        let vendorIdFilter: string[] | null = null;
        if (term) {
          const categoryIds = resolveCategoryIdsForTerm(term, categories);
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
        }

        let q = supabase
          .from("vendors")
          .select("*, verification_status")
          .eq("is_active", true)
          .eq("is_banned", false)
          .gte("latitude", coords.lat - BBOX_DELTA_DEG)
          .lte("latitude", coords.lat + BBOX_DELTA_DEG)
          .gte("longitude", coords.lng - BBOX_DELTA_DEG)
          .lte("longitude", coords.lng + BBOX_DELTA_DEG);

        if (vendorIdFilter) {
          q = q.in("id", vendorIdFilter);
        }

        const { data, error: fetchError } = await q.limit(80);
        if (fetchError) throw fetchError;

        const bboxVendors = (data ?? []).filter(
          (v) =>
            v.latitude != null &&
            v.longitude != null &&
            v.latitude !== 0 &&
            v.longitude !== 0,
        ) as Vendor[];

        const vendorIds = bboxVendors.map((v) => v.id);

        let verificationRows: VendorVerificationRow[] = [];
        let categoriesByVendor = new Map<string, { label: string; emoji: string }[]>();
        const menuByVendor = new Map<string, RadarMenuItem[]>();
        let activeOrderVendorIds = new Set<string>();
        let fulfilledVendorIds = new Set<string>();
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
              supabase
                .from("requests")
                .select("vendor_id")
                .eq("device_id", deviceId)
                .in("vendor_id", vendorIds)
                .in("status", ["sent", "seen"]),
              supabase
                .from("requests")
                .select("vendor_id")
                .eq("device_id", deviceId)
                .in("vendor_id", vendorIds)
                .eq("status", "fulfilled"),
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
          fulfilledVendorIds = new Set((fulfilledResult.data ?? []).map((r) => r.vendor_id));
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
    [coords, coordsTried, term, searchRadiusKm, categories, categoriesLoaded, s.radar_connection_error],
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
    return s.radar_all_emergencies;
  }, [term, s.radar_all_emergencies]);

  const savedByVendorId = useMemo(() => {
    void neighboursSyncTick;
    return Object.fromEntries(
      results.map(({ vendor }) => [
        vendor.id,
        vendor.isSavedNeighbour || readSessionSaved(vendor.id),
      ]),
    );
  }, [results, neighboursSyncTick]);

  return (
    <AppShell theme="dark">
      {locating || (scanning && coords) ? (
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
            </div>
            <NotificationBell />
          </header>

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
            {results.length} {results.length === 1 ? s.radar_match : s.radar_matches}{s.radar_found}
          </p>
          {expanded && results.length > 0 && (
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

      {/* Results */}
      {!locationBlocked && !scanning && !error && results.length > 0 && (
        <section className="space-y-3 mt-4 pb-4">
          {results.map(({ vendor, dist }, i) => (
            <RadarVendorCard
              key={vendor.id}
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
              onOrder={() => {}}
              onAiBridge={() => {}}
              onSave={() => {}}
              onOrderCancelled={() => void fetchVendors({ silent: true })}
            />
          ))}
          {isOfficialEmergencyCategory(term) && <GovEmergencyServices term={term} />}
        </section>
      )}

      {/* 0 results before 50 km: widen only; failsafe comes after 50 km if still empty. */}
      {!locationBlocked &&
        !scanning &&
        !error &&
        results.length === 0 &&
        searchRadiusKm < MAX_RADIUS_KM && (
        <div className="rounded-2xl border border-brand-border bg-surface p-5 mt-4 space-y-4">
          <p className="text-center font-display text-lg font-semibold text-white">
            {searchRadiusKm === NEAR_RADIUS_KM
              ? s.radar_no_helpers_15
              : `${s.radar_no_helpers_15.replace('15', String(searchRadiusKm))}`}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {searchRadiusKm < 25 && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(25)}
                className="flex-1 rounded-xl bg-brand text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_14px_rgba(34,197,94,0.35)]"
              >
                {s.radar_expand_25}
              </button>
            )}
            {searchRadiusKm < 50 && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(50)}
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

      {/* True empty state — no private responders even at 50 km. */}
      {!locationBlocked &&
        !scanning &&
        !error &&
        results.length === 0 &&
        searchRadiusKm >= MAX_RADIUS_KM && (
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


// Trust indicator that proves a vendor is actively at their post.
// Reads the live `last_updated` timestamp from Supabase and labels the gap.
const SignalFreshness = ({ lastUpdated }: { lastUpdated: string | null }) => {
  const { s } = useLanguage();
  if (!lastUpdated) {
    return (
      <span className="inline-flex items-center gap-1 text-gray-400 font-semibold">
        <span className="h-2 w-2 rounded-full bg-gray-500" />
        {s.radar_signal_unknown}
      </span>
    );
  }
  const ageMin = Math.max(
    0,
    Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000),
  );
  if (ageMin < 30) {
    return (
      <span className="inline-flex items-center text-brand font-semibold">
        <span className="relative flex h-2 w-2 mr-1 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        {s.radar_signal_strong}
      </span>
    );
  }
  const label =
    ageMin < 60
      ? `${ageMin}${s.radar_mins_ago}`
      : ageMin < 60 * 24
        ? `${Math.round(ageMin / 60)}${s.radar_h_ago}`
        : `${Math.round(ageMin / (60 * 24))}${s.radar_d_ago}`;
  return (
    <span className="inline-flex items-center gap-1 text-gray-400 font-semibold">
      <span className="h-2 w-2 rounded-full bg-gray-500 shrink-0 mr-1" />
      <Clock className="h-3 w-3" />
      {s.radar_last_active}{label}
    </span>
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
  const resolved = resolveCategory(termForGovEmergencyHelp(term));
  const isMedical = resolved ? MEDICAL.has(resolved) : false;
  const isRoadside = resolved ? ROADSIDE.has(resolved) : false;
  const isFire = resolved ? FIRE.has(resolved) : false;

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
