import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  ArrowLeft,
  MapPin,
  Phone,
  Store,
  AlertTriangle,
  Shield,
  ShieldAlert,
  Loader2,
  Clock,
  Siren,
  ChevronDown,
  Zap,
  HeartHandshake,
  Package,
} from "lucide-react";
import {
  supabase,
  type Vendor,
  distanceKm,
  displayName,
  useCategoryLabel,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, migrateUserPhone } from "@/lib/userIdentity";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { ParchiSheet } from "@/components/ParchiSheet";
import { AiBridgeSheet } from "@/components/AiBridgeSheet";
import { VerificationBadge, vendorTier, verificationCopy } from "@/components/VerificationBadge";
import { toast } from "sonner";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/lib/language";

type Ranked = { vendor: Vendor; dist: number | null };

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

const CALLED_SESSION_PREFIX = "aaspaas:called:";
const PARCHI_SESSION_PREFIX = "aaspaas:parchi:";
function readCalledVendor(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${CALLED_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}
function writeCalledVendor(vendorId: string) {
  try {
    sessionStorage.setItem(`${CALLED_SESSION_PREFIX}${vendorId}`, "1");
  } catch {
    /* ignore */
  }
}
function readParchiVendor(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${PARCHI_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

const SAVED_SESSION_PREFIX = "aaspaas:saved:";
function readSessionSaved(vendorId: string): boolean {
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

function readIsOwnVendorCard(vendorId: string): boolean {
  try {
    const mine = localStorage.getItem(VENDOR_SELF_STORAGE_KEY);
    return mine != null && mine === vendorId;
  } catch {
    return false;
  }
}

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

/** Default geofence; user can widen to 25 km or 50 km before the failsafe UI. */
const NEAR_RADIUS_KM = 15;
const MAX_RADIUS_KM = 50;

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
  const getLabel = useCategoryLabel();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsTried, setCoordsTried] = useState(false);
  const [scanning, setScanning] = useState(true);
  /** Active search radius in km (15 → optional 25 / 50). */
  const [searchRadiusKm, setSearchRadiusKm] = useState(NEAR_RADIUS_KM);
  const [results, setResults] = useState<Ranked[]>([]);
  const [error, setError] = useState<string | null>(null);

  const expanded = searchRadiusKm > NEAR_RADIUS_KM;

  useLayoutEffect(() => {
    setSearchRadiusKm(NEAR_RADIUS_KM);
  }, [term]);

  // Fetch GPS once on mount; we need it for the geofence.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setCoordsTried(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setCoords({ lat: p.coords.latitude, lng: p.coords.longitude });
        setCoordsTried(true);
      },
      () => setCoordsTried(true),
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30_000 },
    );
  }, []);

  // Run search once GPS resolved (or denied — we still scan, just without geofence).
  useEffect(() => {
    if (!coordsTried) return;
    let cancelled = false;
    const run = async () => {
      setScanning(true);
      setError(null);
      try {
        // Let the radar breathe so the transition feels intentional.
        await new Promise((r) => setTimeout(r, 900));

        // Explicitly select verification_status (along with the rest) so the
        // RadarCard can render straight from the DB without any frontend overrides.
        let q = supabase
          .from("vendors")
          .select("*, verification_status")
          .eq("is_active", true);
        if (term) {
          const resolved = resolveCategory(term);
          if (resolved) q = q.eq("category", resolved);
          else q = q.ilike("category", `%${term}%`);
        }
        const { data, error } = await q.limit(80);
        if (error) throw error;
        if (cancelled) return;

        const all: Ranked[] = (data ?? [])
          .filter(
            (v) =>
              v.latitude != null &&
              v.longitude != null &&
              v.latitude !== 0 &&
              v.longitude !== 0,
          )
          .map((v) => ({
            vendor: v as Vendor,
            dist:
              coords && v.latitude != null && v.longitude != null
                ? distanceKm(coords, { lat: v.latitude, lng: v.longitude })
                : null,
          }));

        const within = (radius: number) =>
          all.filter((r) => (coords ? r.dist != null && r.dist <= radius : true));

        const scoped = within(searchRadiusKm);

        // Rank: Green status first (always on top), then by proximity.
        // Yellow/Red helpers fall back to pure distance ordering.
        scoped.sort((a, b) => {
          const ag = vendorTier(a.vendor) === "green" ? 0 : 1;
          const bg = vendorTier(b.vendor) === "green" ? 0 : 1;
          if (ag !== bg) return ag - bg;
          if (a.dist == null && b.dist == null) return 0;
          if (a.dist == null) return 1;
          if (b.dist == null) return -1;
          return a.dist - b.dist;
        });

        if (cancelled) return;
        setResults(scoped);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? s.radar_connection_error);
      } finally {
        if (!cancelled) setScanning(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [coordsTried, coords, term, searchRadiusKm, s.radar_connection_error]);

  const headline = useMemo(() => {
    if (term) return displayName(term);
    return s.radar_all_emergencies;
  }, [term, s.radar_all_emergencies]);

  return (
    <AppShell theme="dark">
      {scanning ? (
        <div className="min-h-[80vh] bg-page-bg flex flex-col items-center justify-center p-6 text-white relative animate-fade-in">
          {/* Back */}
          <button
            onClick={() => navigate("/")}
            className="absolute top-4 left-0 h-10 w-10 grid place-items-center rounded-xl bg-card border border-border"
            aria-label={s.radar_back_home}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          {/* Search Header */}
          <div className="absolute top-12 text-center px-6">
            <h2 className="text-brand text-sm font-bold tracking-widest uppercase mb-2">
              {expanded ? s.radar_expanding_scan : s.radar_scanning_area}
            </h2>
            <p className="text-2xl font-semibold italic capitalize">
              {s.radar_finding_nearby}{headline}…
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
              onClick={() => navigate("/")}
              className="h-10 w-10 grid place-items-center rounded-xl bg-card border border-border"
              aria-label={s.radar_back_home}
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-[0.3em] text-brand">
                {s.radar_live}
              </p>
              <h1 className="font-display text-lg font-bold capitalize">{term ? getLabel(term) : headline}</h1>
            </div>
            <div className="h-10 w-10" />
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

      {/* Error */}
      {error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3 mt-2">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-destructive">{s.radar_connection_error}</p>
            <p className="text-sm text-muted-foreground mt-0.5 break-words">{error}</p>
          </div>
        </div>
      )}

      {/* Results */}
      {!scanning && !error && results.length > 0 && (
        <section className="space-y-3 mt-4 pb-4">
          {results.map(({ vendor, dist }, i) => (
            <RadarVendorCard
              key={vendor.id}
              vendor={vendor}
              dist={dist}
              index={i}
              userNeed={term}
            />
          ))}
          {isOfficialEmergencyCategory(term) && <GovEmergencyServices term={term} />}
        </section>
      )}

      {/* 0 results before 50 km: widen only; failsafe comes after 50 km if still empty. */}
      {!scanning && !error && results.length === 0 && searchRadiusKm < MAX_RADIUS_KM && (
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
      {!scanning && !error && results.length === 0 && searchRadiusKm >= MAX_RADIUS_KM && (
        <EmptyStateFailsafe term={term} />
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

  if (mode === "help") {
    const n = totalHelpedOverride ?? vendor.total_helped ?? 0;
    if (n <= 0) return null;
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
        <span className="inline-flex items-center gap-1 shrink-0">
          <HeartHandshake className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">Helped</span>
        </span>
        <span>
          {s.radar_helped}<span className="font-semibold tabular-nums text-brand">{n}</span>{" "}
          {n === 1 ? s.radar_person : s.radar_people}
        </span>
      </div>
    );
  }

  if (mode === "delivery") {
    const d = totalDeliveredOverride ?? vendor.total_delivered ?? 0;
    if (d <= 0) return null;
    const raw = vendor.on_time_rate;
    const pct =
      typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : null;
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
        <span className="inline-flex items-center gap-1 shrink-0">
          <Package className="h-3.5 w-3.5 opacity-80" />
          <span className="font-semibold">Delivered</span>
        </span>
        <span>
          <span className="font-semibold tabular-nums text-brand">{d}</span>{s.radar_orders_served}
          {pct !== null && d > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="font-semibold tabular-nums text-brand">{pct}</span>{s.radar_on_time}
            </>
          )}
        </span>
      </div>
    );
  }

  return null;
};

const RadarVendorCard = ({
  vendor,
  dist,
  index,
  userNeed,
}: {
  vendor: Vendor;
  dist: number | null;
  index: number;
  /** Search query / category the user looked for (URL `q`). */
  userNeed: string;
}) => {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const tier = vendorTier(vendor);
  const serviceMode = String(vendor.service_mode ?? "")
    .trim()
    .toLowerCase();
  const isOwnVendor = readIsOwnVendorCard(vendor.id);

  const [helpCount, setHelpCount] = useState(() => vendor.total_helped ?? 0);
  const [deliveredCount, setDeliveredCount] = useState(() => vendor.total_delivered ?? 0);
  const [resolutionMarked, setResolutionMarked] = useState(() => readResolutionMarked(vendor.id));
  const [resolutionBusy, setResolutionBusy] = useState(false);

  const [aiSheetOpen, setAiSheetOpen] = useState(false);

  const [parchiOpen, setParchiOpen] = useState(false);
  const [savedVendorLocked, setSavedVendorLocked] = useState(() =>
    readSessionSaved(vendor.id),
  );
  const [resolutionSessionTick, setResolutionSessionTick] = useState(0);
  const [deliveryActiveFromDb, setDeliveryActiveFromDb] = useState(false);
  const [deliveryFulfilledFromDb, setDeliveryFulfilledFromDb] = useState(false);
  const [phoneSheetOpen, setPhoneSheetOpen] = useState(false);

  useEffect(() => {
    setHelpCount(vendor.total_helped ?? 0);
    setDeliveredCount(vendor.total_delivered ?? 0);
    setResolutionMarked(readResolutionMarked(vendor.id));
    setSavedVendorLocked(readSessionSaved(vendor.id));
  }, [vendor.id]);

  useEffect(() => {
    if ((serviceMode !== "delivery" && serviceMode !== "appointment") || isOwnVendor) {
      setDeliveryActiveFromDb(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", vendor.id)
        .in("status", ["sent", "seen"])
        .limit(1);
      if (!cancelled) setDeliveryActiveFromDb(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, serviceMode, isOwnVendor, resolutionSessionTick]);

  useEffect(() => {
    if (serviceMode !== "delivery" || isOwnVendor) {
      setDeliveryFulfilledFromDb(false);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const device_id = getDeviceId();
      const { data } = await supabase
        .from("requests")
        .select("id")
        .eq("device_id", device_id)
        .eq("vendor_id", vendor.id)
        .eq("status", "fulfilled")
        .limit(1);
      if (!cancelled) setDeliveryFulfilledFromDb(!!data?.length);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, serviceMode, isOwnVendor, resolutionSessionTick]);

  useEffect(() => {
    if (isOwnVendor) return;
    if (readSessionSaved(vendor.id)) {
      setSavedVendorLocked(true);
      return;
    }
    let cancelled = false;
    const run = async () => {
      const deviceId = getDeviceId();
      const userPhone = getUserPhone();
      console.log("[RadarVendorCard] saved_vendors check", {
        deviceId,
        userPhone,
        vendorId: vendor.id,
      });
      let savedQuery = supabase
        .from("saved_vendors")
        .select("id")
        .eq("vendor_id", vendor.id)
        .limit(1);
      savedQuery =
        userPhone != null ? savedQuery.eq("user_phone", userPhone) : savedQuery.eq("device_id", deviceId);
      const { data } = await savedQuery;
      if (cancelled || !data?.length) return;
      writeSessionSaved(vendor.id);
      setSavedVendorLocked(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [vendor.id, isOwnVendor]);

  const showResolution =
    !isOwnVendor &&
    ((serviceMode === "help" && readCalledVendor(vendor.id)) ||
      (serviceMode === "delivery" && deliveryFulfilledFromDb));

  const showSendOrderSection = !isOwnVendor && (serviceMode === "delivery" || serviceMode === "appointment");

  const deliveryOrderSent = deliveryActiveFromDb;

  const showSaveRow =
    !isOwnVendor &&
    !readSessionSaved(vendor.id) &&
    !savedVendorLocked;

  const accentRing =
    tier === "green"
      ? "ring-brand/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
      : tier === "yellow"
        ? "ring-warning/40"
        : "ring-destructive/30";

  const handleConnect = useCallback(() => {
    setAiSheetOpen(true);
  }, []);

  const handleSaveVendor = useCallback(async () => {
    if (savedVendorLocked) return;
    const userPhone = getUserPhone();
    if (userPhone === null) {
      setPhoneSheetOpen(true);
      return;
    }
    const device_id = getDeviceId();
    const { error } = await supabase.from("saved_vendors").insert({
      device_id,
      vendor_id: vendor.id,
      category: vendor.category,
      nickname: vendor.shop_name,
      user_phone: userPhone,
    });
    if (error) {
      if (error.code === "23505") {
        writeSessionSaved(vendor.id);
        setSavedVendorLocked(true);
        toast.success(`✅ ${s.radar_saved_success}`);
        return;
      }
      toast.error(s.radar_could_not_save, { description: error.message });
      return;
    }
    writeSessionSaved(vendor.id);
    setSavedVendorLocked(true);
    toast.success(`✅ ${s.radar_saved_success}`);
  }, [savedVendorLocked, vendor.category, vendor.id, vendor.shop_name, s]);

  const handleResolution = useCallback(async () => {
    if (resolutionMarked || resolutionBusy) return;
    const kind = serviceMode === "delivery" ? "delivery" : "help";
    const rpc =
      kind === "help" ? "increment_vendor_helped" : "increment_vendor_delivered";
    setResolutionBusy(true);
    const { error } = await supabase.rpc(rpc, { p_vendor_id: vendor.id });
    setResolutionBusy(false);
    if (error) {
      toast.error(s.radar_could_not_save, { description: error.message });
      return;
    }
    writeResolutionMarked(vendor.id);
    setResolutionMarked(true);
    if (kind === "help") setHelpCount((c) => c + 1);
    else setDeliveredCount((c) => c + 1);
    toast.success(s.radar_thank_community);
  }, [
    resolutionMarked,
    resolutionBusy,
    serviceMode,
    vendor.id,
    s,
  ]);

  return (
    <div
      className={`rounded-2xl bg-card/80 backdrop-blur-xl border border-border ring-1 ${accentRing} p-4 animate-fade-up`}
      style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
    >
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-xl bg-gradient-vendor grid place-items-center shrink-0 overflow-hidden">
          {vendor.shop_photo_url ? (
            <img
              src={vendor.shop_photo_url}
              alt={`${vendor.shop_name} shop`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <span className="inline-flex items-center gap-1">
              <Store className="h-6 w-6 text-primary-foreground" />
              <span className="text-[10px] font-semibold text-primary-foreground">Shop</span>
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <h3 className="font-display font-bold truncate">{vendor.shop_name}</h3>
              {readIsOwnVendorCard(vendor.id) && (
                <span className="text-[10px] font-medium text-muted-foreground shrink-0">
                  • You
                </span>
              )}
            </div>
            <span className="inline-flex items-center gap-1 shrink-0">
              <VerificationBadge vendor={vendor} />
              <span className="text-[10px] font-medium text-muted-foreground whitespace-nowrap">
                {verificationCopy[tier].label}
              </span>
            </span>
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {vendor.name} · {getLabel(vendor.category)}
          </p>
          <VerificationBadge vendor={vendor} showLabel className="mt-1" />
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            {dist != null ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {dist < 1 ? `${Math.round(dist * 1000)} mtr away` : `${dist.toFixed(1)} km away`}
              </span>
            ) : (
              <span>{s.radar_location_unknown}</span>
            )}
          </div>
          {serviceMode === "help" && dist != null && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-brand-muted ring-1 ring-brand/30 px-2 py-0.5 text-[11px] font-semibold text-brand">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>ETA</span>
              </span>
              {s.radar_est_arrival}{Math.max(1, Math.round(dist * 2))}{s.radar_min}
            </div>
          )}
        </div>
      </div>

          {tier === "yellow" && (
        <div className="mt-3 rounded-xl bg-warning/10 border border-warning/60 px-3 py-2 flex items-start gap-2">
          <span className="inline-flex items-center gap-1 shrink-0 mt-0.5">
            <ShieldAlert className="h-4 w-4 text-warning" />
            <span className="text-xs text-warning font-semibold">Pending</span>
          </span>
          <p className="text-xs text-warning font-semibold">
            {s.radar_verification_progress}
          </p>
        </div>
      )}
      {tier === "red" && (
        <div className="mt-3 rounded-xl bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2">
          <span className="inline-flex items-center gap-1 shrink-0 mt-0.5">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-xs text-destructive font-semibold">Unverified</span>
          </span>
          <p className="text-xs text-destructive font-semibold">
            {s.radar_not_verified}
          </p>
        </div>
      )}

      <VendorReputationLine
        vendor={vendor}
        totalHelpedOverride={helpCount}
        totalDeliveredOverride={deliveredCount}
      />

      <button
        type="button"
        onClick={handleConnect}
        className="mt-4 w-full rounded-xl bg-brand text-[#0b1f14] py-3.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
      >
        <Phone className="h-4 w-4" />
        {s.radar_connect_ai}
      </button>

      <AiBridgeSheet
        open={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        vendor={vendor}
        callerPhone={getUserPhone() ?? ""}
        userNeed={userNeed}
        distanceKm={dist}
        onCallSuccess={(vendorId) => {
          writeCalledVendor(vendorId);
          setResolutionSessionTick((n) => n + 1);
        }}
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
              {serviceMode === "appointment" ? `📅 ${s.radar_booking_requested}` : `✅ ${s.radar_order_sent}`}
            </span>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={() => setParchiOpen(true)}
              className="font-semibold text-brand underline underline-offset-2 hover:opacity-90"
            >
              {serviceMode === "appointment" ? s.radar_book_again : s.radar_send_new_order}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setParchiOpen(true)}
            className="mt-2 w-full rounded-xl bg-brand text-[#0b1f14] py-2.5 px-3 text-sm font-semibold active:scale-[0.99] transition-transform shadow-sm"
          >
            {serviceMode === "appointment" ? `📅 ${s.radar_book_service}` : `📋 ${s.radar_send_order}`}
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
              : `✅ ${s.radar_he_helped}`}
        </button>
      )}

      {showSaveRow && (
        <button
          type="button"
          onClick={() => void handleSaveVendor()}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-border text-foreground bg-muted/40 hover:bg-muted/60",
          )}
        >
          {`🔖 ${s.radar_save_as}${getLabel(vendor.category) || s.radar_vendor_fallback}`}
        </button>
      )}
      <ParchiSheet
        vendor={vendor}
        isOpen={parchiOpen}
        onClose={() => setParchiOpen(false)}
        onOrderSent={() => setResolutionSessionTick((n) => n + 1)}
      />
      <PhoneEntrySheet
        isOpen={phoneSheetOpen}
        onClose={() => setPhoneSheetOpen(false)}
        onConfirmed={async (phone) => {
          setPhoneSheetOpen(false);
          await migrateUserPhone(phone, getDeviceId());
          void handleSaveVendor();
        }}
      />
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
// Fire → 101, Medical → 108, Roadside → 1033, Security/Default → 112.
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