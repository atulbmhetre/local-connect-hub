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
  PhoneCall,
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
  fetchAiBridgeBrief,
  displayName,
} from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone, migrateUserPhone } from "@/lib/userIdentity";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";
import { ParchiSheet } from "@/components/ParchiSheet";
import { VerificationBadge, vendorTier } from "@/components/VerificationBadge";
import { toast } from "sonner";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

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

        const all: Ranked[] = (data ?? []).map((v) => ({
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
        if (!cancelled) setError(e.message ?? "Connection Error");
      } finally {
        if (!cancelled) setScanning(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [coordsTried, coords, term, searchRadiusKm]);

  const headline = useMemo(() => {
    if (term) return displayName(term);
    return "All emergencies";
  }, [term]);

  return (
    <AppShell theme="dark">
      {scanning ? (
        <div className="min-h-[80vh] bg-[#121212] flex flex-col items-center justify-center p-6 text-white relative animate-fade-in">
          {/* Back */}
          <button
            onClick={() => navigate("/")}
            className="absolute top-4 left-0 h-10 w-10 grid place-items-center rounded-xl bg-card border border-border"
            aria-label="Back to home"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          {/* Search Header */}
          <div className="absolute top-12 text-center px-6">
            <h2 className="text-[#22C55E] text-sm font-bold tracking-widest uppercase mb-2">
              {expanded ? "Expanding Scan" : "Scanning Area"}
            </h2>
            <p className="text-2xl font-semibold italic capitalize">
              Finding nearby {headline}
              {headline.toLowerCase().endsWith("s") ? "" : "s"}…
            </p>
          </div>

          {/* The Radar Core */}
          <div className="relative flex items-center justify-center w-64 h-64">
            <div className="absolute w-full h-full border-2 border-[#22C55E]/30 rounded-full animate-ping shadow-[0_0_20px_rgba(34,197,94,0.3)]" />
            <div className="absolute w-3/4 h-3/4 border-2 border-[#22C55E]/20 rounded-full animate-[ping_1.5s_linear_infinite]" />
            <div className="absolute w-1/2 h-1/2 border-2 border-[#22C55E]/10 rounded-full animate-[ping_2s_linear_infinite]" />
            <div className="relative z-10 w-24 h-24 bg-[#121212] border-2 border-[#22C55E] rounded-full flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.5)]">
              <Shield className="w-10 h-10 text-[#22C55E] animate-pulse" />
            </div>
          </div>

          {/* Trust Indicator */}
          <div className="absolute bottom-24 flex items-center gap-2 text-gray-400 text-sm text-center px-6">
            <Loader2 className="w-4 h-4 animate-spin text-[#22C55E] shrink-0" />
            <span>Searching within {searchRadiusKm} km</span>
          </div>
        </div>
      ) : (
        <>
          <header className="flex items-center justify-between mb-4 animate-fade-up">
            <button
              onClick={() => navigate("/")}
              className="h-10 w-10 grid place-items-center rounded-xl bg-card border border-border"
              aria-label="Back to home"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-[0.3em] text-[#22C55E]">
                Live Radar
              </p>
              <h1 className="font-display text-lg font-bold capitalize">{headline}</h1>
            </div>
            <div className="h-10 w-10" />
          </header>

          <div className="relative h-32 w-32 mx-auto mb-3">
            <div className="absolute inset-0 rounded-full border-2 border-[#22C55E]/30" />
            <div className="absolute inset-3 rounded-full border-2 border-[#22C55E]/20" />
            <div className="absolute inset-0 grid place-items-center">
              <div className="h-14 w-14 rounded-full bg-[#121212] border-2 border-[#22C55E] grid place-items-center shadow-[0_0_24px_rgba(34,197,94,0.4)]">
                <Shield className="h-6 w-6 text-[#22C55E]" />
              </div>
            </div>
          </div>

          <p className="text-center text-xs uppercase tracking-[0.25em] text-[#22C55E] mb-2">
            {results.length} {results.length === 1 ? "match" : "matches"} found
          </p>
          {expanded && results.length > 0 && (
            <p className="text-center text-[11px] text-muted-foreground mb-4">
              Showing nearest help within {searchRadiusKm} km.
            </p>
          )}
        </>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-2xl bg-destructive/10 border border-destructive/30 p-4 flex gap-3 mt-2">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-destructive">Connection Error</p>
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
        <div className="rounded-2xl border border-[#22C55E]/30 bg-[#1A1A1A] p-5 mt-4 space-y-4">
          <p className="text-center font-display text-lg font-semibold text-white">
            {searchRadiusKm === NEAR_RADIUS_KM
              ? "No helpers found within 15km"
              : `No helpers found within ${searchRadiusKm}km`}
          </p>
          <div className="flex flex-col sm:flex-row gap-2">
            {searchRadiusKm < 25 && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(25)}
                className="flex-1 rounded-xl bg-[#22C55E] text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_14px_rgba(34,197,94,0.35)]"
              >
                Expand to 25km
              </button>
            )}
            {searchRadiusKm < 50 && (
              <button
                type="button"
                onClick={() => setSearchRadiusKm(50)}
                className="flex-1 rounded-xl bg-[#22C55E] text-[#0b1f14] py-3.5 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_14px_rgba(34,197,94,0.35)]"
              >
                Expand to 50km
              </button>
            )}
          </div>
          {showGovHelpAlongsideRadiusExpand(term) && (
            <div className="pt-2 border-t border-[#22C55E]/20">
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
  const showEmergencyNumbers = isOfficialEmergencyCategory(term);

  if (!showEmergencyNumbers) {
    return (
      <div className="rounded-2xl border border-[#22C55E]/30 bg-[#1A1A1A] p-5 mt-4 space-y-5">
        <p className="text-center text-sm text-gray-300 leading-relaxed px-1">
          No helpers found in your area yet. Aaspaas Pro is growing — check back soon or try a
          different category.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[#22C55E]/30 bg-[#1A1A1A] p-5 mt-4 space-y-4">
      <div className="text-center">
        <p className="font-display text-lg font-semibold text-white">
          No private responders currently online
        </p>
        <p className="text-sm text-gray-400 mt-1">
          You can still reach official emergency services below.
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
  const mode = String(vendor.service_mode ?? "")
    .trim()
    .toLowerCase();

  if (mode === "help") {
    const n = totalHelpedOverride ?? vendor.total_helped ?? 0;
    if (n <= 0) return null;
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
        <HeartHandshake className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
        <span>
          Helped <span className="font-semibold tabular-nums text-[#22C55E]">{n}</span>{" "}
          {n === 1 ? "person" : "people"}
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
        <Package className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
        <span>
          <span className="font-semibold tabular-nums text-[#22C55E]">{d}</span> orders served
          {pct !== null && d > 0 && (
            <>
              {" "}
              ·{" "}
              <span className="font-semibold tabular-nums text-[#22C55E]">{pct}</span>% on time
            </>
          )}
        </span>
      </div>
    );
  }

  return null;
};

function telHref(phone: string) {
  return `tel:${phone.replace(/[\s-]/g, "").trim()}`;
}

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
  const [aiSheetLoading, setAiSheetLoading] = useState(false);
  const [aiBriefText, setAiBriefText] = useState<string | null>(null);
  const [aiBriefFailed, setAiBriefFailed] = useState(false);

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
      ? "ring-[#22C55E]/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
      : tier === "yellow"
        ? "ring-[#FACC15]/40"
        : "ring-destructive/30";

  const closeAiSheet = useCallback((open: boolean) => {
    setAiSheetOpen(open);
    if (!open) {
      setAiSheetLoading(false);
      setAiBriefText(null);
      setAiBriefFailed(false);
    }
  }, []);

  const handleConnect = useCallback(async () => {
    const need = userNeed.trim() || vendor.category || "help";
    setAiSheetOpen(true);
    setAiSheetLoading(true);
    setAiBriefFailed(false);
    setAiBriefText(null);

    const result = await fetchAiBridgeBrief({
      vendor_name: vendor.name,
      shop_name: vendor.shop_name,
      category: vendor.category,
      distance_km: dist,
      user_need: need,
    });

    setAiSheetLoading(false);
    if (result.ok) {
      setAiBriefText(result.brief);
      setAiBriefFailed(false);
    } else {
      setAiBriefText(null);
      setAiBriefFailed(true);
    }
  }, [userNeed, vendor.name, vendor.shop_name, vendor.category, dist]);

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
        toast.success("✅ Saved! Find them on your home screen.");
        return;
      }
      toast.error("Could not save", { description: error.message });
      return;
    }
    writeSessionSaved(vendor.id);
    setSavedVendorLocked(true);
    toast.success("✅ Saved! Find them on your home screen.");
  }, [savedVendorLocked, vendor.category, vendor.id, vendor.shop_name]);

  const handleResolution = useCallback(async () => {
    if (resolutionMarked || resolutionBusy) return;
    const kind = serviceMode === "delivery" ? "delivery" : "help";
    const rpc =
      kind === "help" ? "increment_vendor_helped" : "increment_vendor_delivered";
    setResolutionBusy(true);
    const { error } = await supabase.rpc(rpc, { p_vendor_id: vendor.id });
    setResolutionBusy(false);
    if (error) {
      toast.error("Could not save", { description: error.message });
      return;
    }
    writeResolutionMarked(vendor.id);
    setResolutionMarked(true);
    if (kind === "help") setHelpCount((c) => c + 1);
    else setDeliveredCount((c) => c + 1);
    toast.success("Thank you! This helps the community.");
  }, [
    resolutionMarked,
    resolutionBusy,
    serviceMode,
    vendor.id,
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
            <Store className="h-6 w-6 text-primary-foreground" />
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
            <VerificationBadge vendor={vendor} />
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {vendor.name} · {vendor.category}
          </p>
          <VerificationBadge vendor={vendor} showLabel className="mt-1" />
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            {dist != null ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}
              </span>
            ) : (
              <span>Location unknown</span>
            )}
            <SignalFreshness lastUpdated={vendor.last_updated ?? null} />
          </div>
          {serviceMode === "help" && dist != null && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[#22C55E]/10 ring-1 ring-[#22C55E]/30 px-2 py-0.5 text-[11px] font-semibold text-[#22C55E]">
              <Clock className="h-3 w-3" />
              Est. arrival ~{Math.max(1, Math.round(dist * 2))} min
            </div>
          )}
        </div>
      </div>

      {tier === "yellow" && (
        <div className="mt-3 rounded-xl bg-[#FACC15]/10 border border-[#FACC15]/60 px-3 py-2 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-[#FACC15] shrink-0 mt-0.5" />
          <p className="text-xs text-[#FACC15] font-semibold">
            Verification in Progress — Proceed with caution.
          </p>
        </div>
      )}
      {tier === "red" && (
        <div className="mt-3 rounded-xl bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-xs text-destructive font-semibold">
            Warning: Identity Not Verified — connect at your own risk.
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
        className="mt-4 w-full rounded-xl bg-[#22C55E] text-[#0b1f14] py-3.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
      >
        <Phone className="h-4 w-4" />
        Connect via AI-Bridge
      </button>

      <Sheet open={aiSheetOpen} onOpenChange={closeAiSheet}>
        <SheetContent
          side="bottom"
          className="bg-[#0a0a0a] border-t border-[#1f1f1f] text-white rounded-t-2xl max-h-[85vh] overflow-y-auto"
        >
          <SheetHeader className="text-left space-y-1 pr-8">
            <SheetTitle className="text-white font-display">AI-Bridge</SheetTitle>
            <SheetDescription className="text-gray-400">
              {aiSheetLoading
                ? "Briefing vendor via AI…"
                : aiBriefFailed
                  ? "AI brief unavailable — call directly"
                  : "Your call brief"}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {aiSheetLoading && (
              <div className="flex items-center gap-3 py-6 text-gray-300">
                <Loader2 className="h-6 w-6 animate-spin text-[#22C55E] shrink-0" />
                <p className="text-sm">Briefing vendor via AI…</p>
              </div>
            )}

            {!aiSheetLoading && aiBriefFailed && (
              <p className="text-sm text-amber-200/90 leading-relaxed">
                AI brief unavailable — call directly
              </p>
            )}

            {!aiSheetLoading && !aiBriefFailed && aiBriefText && (
              <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{aiBriefText}</p>
            )}

            {!aiSheetLoading && vendor.vendor_note && (
              <div className="rounded-xl border border-[#22C55E]/30 bg-[#22C55E]/5 px-3 py-2 text-[11px] text-[#22C55E]">
                📌 {vendor.vendor_note}
              </div>
            )}

            {!aiSheetLoading && (
              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  className="w-full rounded-xl bg-[#22C55E] text-[#0a0a0a] py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
                  onClick={() => {
                    writeCalledVendor(vendor.id);
                    setResolutionSessionTick((n) => n + 1);
                    window.open(telHref(vendor.phone), "_self");
                  }}
                >
                  <PhoneCall className="h-4 w-4" />
                  Call Now
                </button>
                <button
                  type="button"
                  className="w-full rounded-xl border border-[#333] bg-transparent text-gray-300 py-3 font-semibold active:scale-[0.99] transition-transform"
                  onClick={() => closeAiSheet(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {showSendOrderSection &&
        (deliveryOrderSent ? (
          <div
            className={cn(
              "mt-2 w-full rounded-xl border px-3 py-2.5 text-sm",
              "border-[#22C55E]/50 bg-[#22C55E]/5 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1",
            )}
          >
            <span className="text-muted-foreground font-medium">
              {serviceMode === "appointment" ? "📅 Booking Requested" : "✅ Order Sent"}
            </span>
            <span className="text-muted-foreground" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={() => setParchiOpen(true)}
              className="font-semibold text-[#22C55E] underline underline-offset-2 hover:opacity-90"
            >
              {serviceMode === "appointment" ? "Book Again" : "Send New Order"}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setParchiOpen(true)}
            className="mt-2 w-full rounded-xl bg-[#22C55E] text-[#0b1f14] py-2.5 px-3 text-sm font-semibold active:scale-[0.99] transition-transform shadow-sm"
          >
            {serviceMode === "appointment" ? "📅 Book a Service" : "📋 Send Order"}
          </button>
        ))}

      {showResolution && (
        <button
          type="button"
          onClick={handleResolution}
          disabled={resolutionMarked || resolutionBusy}
          className={cn(
            "mt-2 w-full rounded-xl border py-2.5 px-3 text-sm font-semibold transition-colors active:scale-[0.99]",
            "border-[#22C55E]/70 text-[#22C55E] bg-transparent",
            "hover:bg-[#22C55E]/10",
            (resolutionMarked || resolutionBusy) && "opacity-60 cursor-not-allowed hover:bg-transparent",
          )}
        >
          {resolutionMarked
            ? "✅ Marked!"
            : serviceMode === "delivery"
              ? "📦 Delivered on Time"
              : "✅ He Helped Me"}
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
          {`🔖 Save as My ${vendor.category || "Vendor"}`}
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
  if (!lastUpdated) {
    return (
      <span className="inline-flex items-center gap-1 text-gray-400 font-semibold">
        <span className="h-2 w-2 rounded-full bg-gray-500" />
        Signal: Unknown
      </span>
    );
  }
  const ageMin = Math.max(
    0,
    Math.round((Date.now() - new Date(lastUpdated).getTime()) / 60000),
  );
  if (ageMin < 30) {
    return (
      <span className="inline-flex items-center text-[#22C55E] font-semibold">
        <span className="relative flex h-2 w-2 mr-1 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
        </span>
        Signal: Strong
      </span>
    );
  }
  const label =
    ageMin < 60
      ? `${ageMin} mins ago`
      : ageMin < 60 * 24
        ? `${Math.round(ageMin / 60)}h ago`
        : `${Math.round(ageMin / (60 * 24))}d ago`;
  return (
    <span className="inline-flex items-center gap-1 text-gray-400 font-semibold">
      <span className="h-2 w-2 rounded-full bg-gray-500 shrink-0 mr-1" />
      <Clock className="h-3 w-3" />
      Last Active: {label}
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
      <div className="rounded-2xl border border-destructive/40 bg-[#1A1A1A] overflow-hidden">
        <CollapsibleTrigger className="w-full flex items-center justify-between gap-3 p-4 group">
          <div className="flex items-center gap-2 min-w-0">
            <Siren className="h-4 w-4 text-destructive shrink-0" />
            <div className="text-left min-w-0">
              <p className="text-[10px] uppercase tracking-[0.3em] text-destructive font-bold">
                Govt. Help
              </p>
              <p className="text-xs text-gray-400 truncate">
                Tap to open · Primary line: {primary.number}
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
              className="flex items-center gap-3 rounded-xl bg-[#121212] border border-destructive/30 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
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
            className="flex items-center gap-3 rounded-xl bg-[#121212] border border-destructive/20 hover:border-destructive p-3 transition-colors active:scale-[0.99]"
          >
            <div className="h-10 w-10 rounded-lg bg-destructive/15 grid place-items-center shrink-0">
              <PhoneCall className="h-4 w-4 text-destructive" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white truncate">Local Police</p>
              <p className="text-[11px] text-gray-400 truncate">
                Nearest police station dispatch
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