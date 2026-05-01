import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import {
  ArrowLeft,
  MapPin,
  Phone,
  Store,
  AlertTriangle,
  ShieldCheck,
  Shield,
  ShieldAlert,
  Loader2,
  PhoneCall,
  Hospital,
  Compass,
  Clock,
  Siren,
} from "lucide-react";
import { supabase, type Vendor, distanceKm, CATEGORIES } from "@/lib/supabase";
import { toast } from "sonner";

type Ranked = { vendor: Vendor; dist: number | null };

// Read the raw `verification_status` column from Supabase and normalize it
// to one of "green" | "yellow" | "red". Anything unknown or null falls back
// to "red" so we never silently downgrade a warning.
type StatusTier = "green" | "yellow" | "red";
function readVerificationStatus(v: Vendor): StatusTier {
  const raw = (v.verification_status ?? "").toString().trim().toLowerCase();
  if (raw === "green" || raw === "business_verified") return "green";
  if (raw === "yellow" || raw === "identity_linked") return "yellow";
  return "red";
}

// Strict resolver mirrors Home: maps free-text/voice to canonical category labels.
const KNOWN_CATEGORIES: { label: string; aliases: string[] }[] = [
  { label: "Mechanic", aliases: ["mechanic", "garage", "repair", "engine", "car repair", "bike repair"] },
  { label: "Towing", aliases: ["towing", "tow", "tow truck", "breakdown", "crane"] },
  { label: "Tyre Service", aliases: ["tyre", "tire", "puncture", "flat tyre", "wheel"] },
  { label: "Key Maker", aliases: ["key", "keymaker", "locksmith", "duplicate key", "lock"] },
  { label: "Ambulance", aliases: ["ambulance", "emergency", "hospital", "108"] },
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

const TIER_RANK: Record<"green" | "yellow" | "red", number> = { green: 0, yellow: 1, red: 2 };
const NEAR_RADIUS_KM = 15;
const WIDE_RADIUS_KM = 50;

// Category-specific failsafe. "medical" / "roadside" / "emergency" route to
// a relevant official authority; "non-emergency" gets a pivot UI instead.
type HelpKind = "medical" | "roadside" | "emergency" | "non_emergency";
type OfficialHelp = {
  kind: HelpKind;
  authority: string;
  number: string;
  tagline: string;
  secondary?: { label: string; href: string };
};
const MEDICAL = new Set(["Ambulance", "Pharmacy", "Nursing"]);
const ROADSIDE = new Set(["Mechanic", "Towing", "Tyre Service"]);
const EMERGENCY_112 = new Set(["Security", "Electrician", "Plumber"]);
const NON_EMERGENCY = new Set(["Key Maker", "Hotel"]);
const DEFAULT_OFFICIAL: OfficialHelp = {
  kind: "emergency",
  authority: "National Emergency (112)",
  number: "112",
  tagline: "All-in-one police, fire & medical response.",
};
function pickOfficialHelp(term: string): OfficialHelp {
  const resolved = resolveCategory(term);
  const raw = term.toLowerCase().trim();
  const key = resolved ?? (raw === "hotel" ? "Hotel" : "");
  if (MEDICAL.has(key)) {
    return {
      kind: "medical",
      authority: "National Health Helpline (108)",
      number: "108",
      tagline: "Free 24×7 emergency medical response.",
      secondary: {
        label: "Find Nearest Govt Hospital",
        href: "https://www.google.com/maps/search/government+hospital+near+me",
      },
    };
  }
  if (ROADSIDE.has(key)) {
    return {
      kind: "roadside",
      authority: "Highway Emergency (1033)",
      number: "1033",
      tagline: "National highway breakdown & road assistance.",
    };
  }
  if (EMERGENCY_112.has(key)) return DEFAULT_OFFICIAL;
  if (NON_EMERGENCY.has(key)) {
    return { ...DEFAULT_OFFICIAL, kind: "non_emergency" };
  }
  return DEFAULT_OFFICIAL;
}

const RadarSearch = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const term = (params.get("q") ?? "").trim();

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [coordsTried, setCoordsTried] = useState(false);
  const [scanning, setScanning] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [results, setResults] = useState<Ranked[]>([]);
  const [error, setError] = useState<string | null>(null);

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
      setExpanded(false);
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

        let scoped = within(NEAR_RADIUS_KM);
        let didExpand = false;
        if (coords && scoped.length === 0) {
          // Empty-state widening: announce, wait for the radar to spin again,
          // then re-scan at 50km.
          setExpanded(true);
          didExpand = true;
          await new Promise((r) => setTimeout(r, 1100));
          scoped = within(WIDE_RADIUS_KM);
        }

        // Rank: Green → Yellow → Red, then by distance (nulls last).
        scoped.sort((a, b) => {
          const ta = TIER_RANK[readVerificationStatus(a.vendor)];
          const tb = TIER_RANK[readVerificationStatus(b.vendor)];
          if (ta !== tb) return ta - tb;
          if (a.dist == null && b.dist == null) return 0;
          if (a.dist == null) return 1;
          if (b.dist == null) return -1;
          return a.dist - b.dist;
        });

        if (cancelled) return;
        setExpanded(didExpand);
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
  }, [coordsTried, coords, term]);

  const headline = useMemo(() => {
    if (term) return term;
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
            <span>
              {expanded
                ? "Searching wider — professionals currently online within 50 km"
                : "Searching for professionals currently online within 15 km"}
            </span>
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
              No one within 15 km — showing nearest help up to 50 km away.
            </p>
          )}

          {/* Horizontal category filter — taps re-run a 15 km active scan. */}
          <CategoryFilterBar
            active={resolveCategory(term) ?? term}
            onPick={(label) => navigate(`/radar?q=${encodeURIComponent(label)}`)}
          />
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
            <RadarVendorCard key={vendor.id} vendor={vendor} dist={dist} index={i} />
          ))}
        </section>
      )}

      {/* True empty state — even widened search returned nothing. */}
      {!scanning && !error && results.length === 0 && (
        <EmptyStateFailsafe term={term} coords={coords} navigate={navigate} />
      )}

      {/* Always-on Government & Emergency Services footer. */}
      {!scanning && !error && results.length > 0 && (
        <GovEmergencyServices term={term} />
      )}
    </AppShell>
  );
};

// Critical failsafe shown when neither 15 km nor 50 km returned a private
// responder. We surface an official authority first, then offer a pivot grid.
const EmptyStateFailsafe = ({
  term,
  coords,
  navigate,
}: {
  term: string;
  coords: { lat: number; lng: number } | null;
  navigate: ReturnType<typeof useNavigate>;
}) => {
  const official = useMemo(() => pickOfficialHelp(term), [term]);
  const [wider, setWider] = useState(false);
  const [widerResults, setWiderResults] = useState<
    { label: string; emoji: string; count: number }[]
  >([]);
  const [widerLoading, setWiderLoading] = useState(false);

  useEffect(() => {
    if (official.kind !== "non_emergency" || !wider) return;
    let cancelled = false;
    (async () => {
      setWiderLoading(true);
      try {
        const { data } = await supabase
          .from("vendors")
          .select("category, latitude, longitude")
          .eq("is_active", true)
          .limit(300);
        const counts = new Map<string, number>();
        (data ?? []).forEach((v: any) => {
          if (!coords || v.latitude == null || v.longitude == null) return;
          const d = distanceKm(coords, { lat: v.latitude, lng: v.longitude });
          if (d <= 100) counts.set(v.category, (counts.get(v.category) ?? 0) + 1);
        });
        const top = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([label, count]) => {
            const cat = CATEGORIES.find(
              (c) => c.label.toLowerCase() === label.toLowerCase(),
            );
            return { label, emoji: cat?.emoji ?? "✨", count };
          });
        if (!cancelled) setWiderResults(top);
      } finally {
        if (!cancelled) setWiderLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [official.kind, wider, coords]);

  const isNonEmergency = official.kind === "non_emergency";

  return (
    <div className="rounded-2xl border border-[#22C55E]/30 bg-[#1A1A1A] p-5 mt-4 space-y-5">
      <div className="text-center">
        <p className="font-display text-lg font-semibold text-white">
          No private responders currently online
        </p>
        <p className="text-sm text-gray-400 mt-1">
          {isNonEmergency
            ? "Try expanding your search or picking a similar category."
            : coords
              ? "Checking official emergency links…"
              : "We couldn't read your location. Try official help below or pick a category."}
        </p>
      </div>

      {isNonEmergency ? (
        <div className="rounded-2xl bg-[#121212] border border-[#22C55E]/40 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Compass className="h-4 w-4 text-[#22C55E]" />
            <p className="text-[10px] uppercase tracking-[0.3em] text-[#22C55E] font-bold">
              Search Wider
            </p>
          </div>
          <p className="text-sm text-white">
            Expand the radar beyond 50 km to find more active professionals.
          </p>
          <button
            onClick={() => setWider((w) => !w)}
            role="switch"
            aria-checked={wider}
            className={`mt-3 w-full rounded-xl py-3 flex items-center justify-center gap-2 font-semibold transition-colors ${
              wider
                ? "bg-[#22C55E] text-[#0b1f14]"
                : "bg-[#1A1A1A] border border-[#22C55E]/40 text-white"
            }`}
          >
            {wider ? "Wider search: ON (100 km)" : "Enable wider search (100 km)"}
          </button>

          {wider && (
            <div className="mt-4">
              <p className="text-[10px] uppercase tracking-[0.3em] text-gray-400 mb-2">
                3 closest active categories
              </p>
              {widerLoading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <Loader2 className="h-4 w-4 animate-spin text-[#22C55E]" />
                  Scanning 100 km radius…
                </div>
              ) : widerResults.length === 0 ? (
                <p className="text-sm text-gray-400">
                  No active categories found nearby yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {widerResults.map((r) => (
                    <button
                      key={r.label}
                      onClick={() =>
                        navigate(`/radar?q=${encodeURIComponent(r.label)}`)
                      }
                      className="w-full rounded-xl bg-[#1A1A1A] border border-[#22C55E]/30 hover:border-[#22C55E] p-3 flex items-center gap-3 active:scale-[0.98] transition"
                    >
                      <span className="text-xl">{r.emoji}</span>
                      <span className="flex-1 text-left text-white font-semibold">
                        {r.label}
                      </span>
                      <span className="text-xs text-[#22C55E]">
                        {r.count} online
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl bg-[#121212] border-2 border-destructive/60 p-4 shadow-[0_0_24px_hsl(var(--destructive)/0.35)]">
          <div className="flex items-center gap-2 mb-2">
            <span className="h-2 w-2 rounded-full bg-destructive animate-pulse shadow-[0_0_8px_hsl(var(--destructive)/0.9)]" />
            <p className="text-[10px] uppercase tracking-[0.3em] text-destructive font-bold">
              Official Help
            </p>
          </div>
          <p className="font-display text-base font-bold text-white">
            {official.authority}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{official.tagline}</p>
          <a
            href={`tel:${official.number}`}
            className="mt-3 w-full rounded-xl bg-destructive text-destructive-foreground py-3.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform shadow-[0_0_18px_hsl(var(--destructive)/0.55)]"
          >
            <PhoneCall className="h-4 w-4" />
            Connect to Official Help · {official.number}
          </a>
          {official.secondary && (
            <a
              href={official.secondary.href}
              target="_blank"
              rel="noreferrer"
              className="mt-2 w-full rounded-xl bg-[#1A1A1A] border border-[#22C55E]/40 text-[#22C55E] py-3 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform"
            >
              <Hospital className="h-4 w-4" />
              {official.secondary.label}
            </a>
          )}
        </div>
      )}

      <div>
        <p className="text-[10px] uppercase tracking-[0.3em] text-[#22C55E] text-center mb-3">
          Or try another service
        </p>
        <div className="grid grid-cols-3 gap-2.5">
          {CATEGORIES.filter((c) => c.id !== "other")
            .slice(0, 6)
            .map((c) => (
              <button
                key={c.id}
                onClick={() => navigate(`/radar?q=${encodeURIComponent(c.label)}`)}
                className="rounded-xl bg-[#121212] border border-[#22C55E]/30 hover:border-[#22C55E] hover:bg-[#22C55E]/10 transition-colors p-3 flex flex-col items-center gap-1.5 active:scale-95"
              >
                <span className="text-2xl leading-none">{c.emoji}</span>
                <span className="text-[11px] font-semibold text-white text-center leading-tight">
                  {c.label}
                </span>
              </button>
            ))}
        </div>
      </div>
    </div>
  );
};

const RadarVendorCard = ({
  vendor,
  dist,
  index,
}: {
  vendor: Vendor;
  dist: number | null;
  index: number;
}) => {
  const navigate = useNavigate();
  // Drive every visual from the live `verification_status` column — no
  // hardcoded overrides, no fallback to legacy heuristics.
  const tier = readVerificationStatus(vendor);
  const accentRing =
    tier === "green"
      ? "ring-[#22C55E]/50 shadow-[0_0_24px_rgba(34,197,94,0.25)]"
      : tier === "yellow"
        ? "ring-[#FACC15]/40"
        : "ring-destructive/30";

  const handleConnect = () => {
    toast("AI-Bridge Call", {
      description: `Connecting you to ${vendor.name} (${vendor.shop_name}). Live bridging coming soon.`,
    });
    navigate(`/track/${vendor.id}`);
  };

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
          <div className="flex items-center gap-1.5">
            <h3 className="font-display font-bold truncate">{vendor.shop_name}</h3>
            {tier === "green" && (
              <ShieldCheck
                className="h-4 w-4 text-[#22C55E] shrink-0"
                strokeWidth={2.5}
                aria-label="Verified"
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate">
            {vendor.name} · {vendor.category}
          </p>
          {tier === "green" && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-[#22C55E]/15 text-[#22C55E] ring-1 ring-[#22C55E]/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider">
              <ShieldCheck className="h-3 w-3" strokeWidth={2.5} />
              Verified Professional
            </span>
          )}
          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            {dist != null ? (
              <span className="inline-flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {dist < 1 ? `${Math.round(dist * 1000)} m` : `${dist.toFixed(1)} km`}
              </span>
            ) : (
              <span>Location unknown</span>
            )}
            <span className="inline-flex items-center gap-1 text-[#22C55E] font-semibold">
              <span className="h-2 w-2 rounded-full bg-[#22C55E] animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.8)]" />
              Ready to Help
            </span>
          </div>
          {dist != null && (
            <div className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[#22C55E]/10 ring-1 ring-[#22C55E]/30 px-2 py-0.5 text-[11px] font-semibold text-[#22C55E]">
              <Clock className="h-3 w-3" />
              Est. arrival ~{Math.max(1, Math.round(dist * 2))} min
            </div>
          )}
        </div>
      </div>

      {tier === "green" && (
        null
      )}
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

      <button
        onClick={handleConnect}
        className="mt-4 w-full rounded-xl bg-primary text-primary-foreground py-3.5 flex items-center justify-center gap-2 font-semibold active:scale-[0.98] transition-transform shadow-glow"
      >
        <Phone className="h-4 w-4" />
        Connect via AI-Bridge
      </button>
    </div>
  );
};

export default RadarSearch;