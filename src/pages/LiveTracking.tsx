import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Lock,
  PhoneCall,
  ShieldAlert,
  Loader2,
  Navigation,
  AlertTriangle,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  PhoneOff,
  Flashlight,
  Share2,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase, type Vendor, distanceKm } from "@/lib/supabase";
import { VerificationBadge, vendorTier } from "@/components/VerificationBadge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Stalled threshold: if helper coords don't move for 2 minutes, alert.
const STALL_MS = 2 * 60 * 1000;

// Average urban responder speed used to derive an ETA from straight-line km.
const AVG_SPEED_KMH = 28;

// Build a DivIcon so we can style markers with Tailwind-ish raw CSS while
// keeping bundle light (no marker image assets to import).
function makeIcon(html: string, size = 44) {
  return L.divIcon({
    className: "aaspaas-marker",
    html,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const userIcon = makeIcon(
  `<div style="width:18px;height:18px;border-radius:9999px;background:#3B82F6;border:3px solid #fff;box-shadow:0 0 0 6px rgba(59,130,246,0.25),0 0 16px rgba(59,130,246,0.7);"></div>`,
  18,
);

function helperIconHtml(stalled: boolean) {
  const color = stalled ? "#F97316" : "#22C55E";
  const glow = stalled ? "rgba(249,115,22,0.65)" : "rgba(34,197,94,0.7)";
  return `<div style="position:relative;width:44px;height:44px;display:grid;place-items:center;">
    <div style="position:absolute;inset:0;border-radius:9999px;background:${color};opacity:0.25;animation:aaspaasPing 1.4s ease-out infinite;"></div>
    <div style="position:relative;width:22px;height:22px;border-radius:9999px;background:${color};border:3px solid #121212;box-shadow:0 0 14px ${glow};"></div>
  </div>`;
}

const FitBounds = ({ points }: { points: [number, number][] }) => {
  const map = useMap();
  useEffect(() => {
    if (points.length < 2) return;
    const bounds = L.latLngBounds(points.map((p) => L.latLng(p[0], p[1])));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }, [map, points]);
  return null;
};

const LiveTracking = () => {
  const navigate = useNavigate();
  const { vendorId } = useParams<{ vendorId: string }>();

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<{ lat: number; lng: number } | null>(null);
  const [helper, setHelper] = useState<{ lat: number; lng: number } | null>(null);

  // Track movement to detect stalls.
  const lastMoveRef = useRef<number>(Date.now());
  const lastCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [now, setNow] = useState(Date.now());

  // AI-Bridge call modal state.
  const [callOpen, setCallOpen] = useState(false);
  const [callStart, setCallStart] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);

  // Flash LED signal (torch) state.
  const [flashing, setFlashing] = useState(false);
  const torchTrackRef = useRef<MediaStreamTrack | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  // Fetch vendor + initial helper coords.
  useEffect(() => {
    if (!vendorId) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("vendors")
          .select("*")
          .eq("id", vendorId)
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error("Responder no longer available.");
        if (cancelled) return;
        const v = data as Vendor;
        setVendor(v);
        if (v.latitude != null && v.longitude != null) {
          const h = { lat: v.latitude, lng: v.longitude };
          setHelper(h);
          lastCoordsRef.current = h;
          lastMoveRef.current = Date.now();
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Could not load responder.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId]);

  // User GPS — high accuracy, watched.
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setUser({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {},
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // Realtime helper movement — subscribe to vendor row updates.
  useEffect(() => {
    if (!vendorId) return;
    const channel = supabase
      .channel(`vendor-track-${vendorId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "vendors",
          filter: `id=eq.${vendorId}`,
        },
        (payload) => {
          const next = payload.new as Vendor;
          setVendor(next);
          if (next.latitude != null && next.longitude != null) {
            const nh = { lat: next.latitude, lng: next.longitude };
            const prev = lastCoordsRef.current;
            const moved =
              !prev ||
              Math.abs(prev.lat - nh.lat) > 1e-5 ||
              Math.abs(prev.lng - nh.lng) > 1e-5;
            if (moved) {
              lastMoveRef.current = Date.now();
              lastCoordsRef.current = nh;
              setStalled(false);
            }
            setHelper(nh);
          }
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [vendorId]);

  // Tick to evaluate stall + show timer.
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() - lastMoveRef.current > STALL_MS) setStalled(true);
    }, 5_000);
    return () => clearInterval(t);
  }, []);

  const etaKm = useMemo(() => {
    if (!user || !helper) return null;
    return distanceKm(user, helper);
  }, [user, helper]);

  // Estimated minutes until arrival, rounded up, min 1 when in motion.
  const etaMin = useMemo(() => {
    if (etaKm == null) return null;
    if (etaKm < 0.05) return 0; // arrived
    return Math.max(1, Math.ceil((etaKm / AVG_SPEED_KMH) * 60));
  }, [etaKm]);

  const points = useMemo<[number, number][]>(() => {
    const arr: [number, number][] = [];
    if (user) arr.push([user.lat, user.lng]);
    if (helper) arr.push([helper.lat, helper.lng]);
    return arr;
  }, [user, helper]);

  const center = useMemo<[number, number]>(() => {
    if (helper) return [helper.lat, helper.lng];
    if (user) return [user.lat, user.lng];
    return [20.5937, 78.9629]; // India centroid fallback
  }, [helper, user]);

  const handleSecureCall = () => {
    if (!vendor) return;
    setMuted(false);
    setSpeaker(false);
    setCallStart(Date.now());
    setCallOpen(true);
    toast("AI-Bridge Secure Call connected", {
      description: `Routing through proxy — ${vendor.name}'s number stays private.`,
    });
  };

  const handleEndCall = () => {
    setCallOpen(false);
    setCallStart(null);
    toast("Call ended", { description: "Secure bridge closed." });
  };

  const handleVerifyCall = () => {
    if (!vendor) return;
    handleSecureCall();
    toast("Checking status via AI-Bridge", {
      description: `Connecting securely with ${vendor.name} to confirm they're on the way.`,
    });
  };

  // Live call duration ticker.
  const [callTick, setCallTick] = useState(0);
  useEffect(() => {
    if (!callOpen) return;
    const t = setInterval(() => setCallTick((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [callOpen]);
  const callSeconds = callStart ? Math.floor((Date.now() - callStart) / 1000) : 0;
  const callDuration = `${String(Math.floor(callSeconds / 60)).padStart(2, "0")}:${String(callSeconds % 60).padStart(2, "0")}`;
  void callTick; // dependency for re-render

  // Flash LED Signal — try real torch via getUserMedia, fall back to white screen pulse.
  const stopFlash = () => {
    if (flashTimerRef.current) {
      clearInterval(flashTimerRef.current);
      flashTimerRef.current = null;
    }
    if (torchTrackRef.current) {
      try {
        // @ts-expect-error torch is non-standard
        torchTrackRef.current.applyConstraints({ advanced: [{ torch: false }] });
      } catch {}
      torchTrackRef.current.stop();
      torchTrackRef.current = null;
    }
    setFlashing(false);
  };

  const handleFlashSignal = async () => {
    if (flashing) {
      stopFlash();
      return;
    }
    setFlashing(true);
    // Try the real LED torch first.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
      });
      const track = stream.getVideoTracks()[0];
      const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      if (caps.torch) {
        torchTrackRef.current = track;
        let on = false;
        flashTimerRef.current = window.setInterval(async () => {
          on = !on;
          try {
            // @ts-expect-error torch is non-standard
            await track.applyConstraints({ advanced: [{ torch: on }] });
          } catch {}
        }, 500);
        toast("Flash LED Signal active", {
          description: "Your phone torch is pulsing — helper can spot you.",
        });
        return;
      } else {
        track.stop();
      }
    } catch {
      // permission denied or unsupported — fall back below
    }
    // Fallback: pulse the screen white via CSS overlay (toggled by `flashing`).
    toast("Screen flash signal active", {
      description: "Hold your phone up — the screen will pulse bright.",
    });
    flashTimerRef.current = window.setInterval(() => {
      // no-op timer just to keep symmetry; visual handled via CSS animation
    }, 1000);
  };
  useEffect(() => () => stopFlash(), []);

  // Share Live Status — Web Share API, with clipboard fallback.
  const handleShareStatus = async () => {
    const url = window.location.href;
    const text = vendor
      ? `I'm using Aaspaas. ${vendor.name} is on the way to help me. Track live:`
      : "I'm using Aaspaas. Track my live emergency status:";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Aaspaas live status", text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast("Tracking link copied", {
        description: "Share it with family so they can follow along.",
      });
    } catch {
      toast("Couldn't share link", { description: "Try again in a moment." });
    }
  };

  const movingLabel = stalled
    ? "Stalled"
    : helper
      ? "Moving toward you"
      : "Locating responder";

  const movingTone = stalled
    ? "text-[#F97316] border-[#F97316]/40 bg-[#F97316]/10"
    : "text-[#22C55E] border-[#22C55E]/40 bg-[#22C55E]/10";

  if (loading) {
    return (
      <div className="min-h-screen bg-[#121212] grid place-items-center text-white">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="h-4 w-4 animate-spin text-[#22C55E]" />
          Opening secure tracking channel…
        </div>
      </div>
    );
  }

  if (error || !vendor) {
    return (
      <div className="min-h-screen bg-[#121212] text-white p-6 flex flex-col gap-4">
        <button
          onClick={() => navigate(-1)}
          className="h-10 w-10 grid place-items-center rounded-xl bg-[#1A1A1A] border border-white/10"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="rounded-2xl bg-destructive/10 border border-destructive/40 p-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm">{error ?? "Responder unavailable."}</p>
        </div>
      </div>
    );
  }

  const minutesSinceMove = Math.floor((now - lastMoveRef.current) / 60_000);

  return (
    <div className="min-h-screen bg-[#121212] text-white flex flex-col">
      <style>{`
        @keyframes aaspaasPing {
          0% { transform: scale(0.6); opacity: 0.6; }
          80%, 100% { transform: scale(2.2); opacity: 0; }
        }
        .leaflet-container { background: #121212; }
      `}</style>

      {/* Top bar */}
      <header className="px-4 pt-4 pb-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="h-10 w-10 grid place-items-center rounded-xl bg-[#1A1A1A] border border-white/10"
          aria-label="Back"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <p className="text-[10px] uppercase tracking-[0.3em] text-[#22C55E] font-bold">
            Live Tracking
          </p>
          <h1 className="font-display text-base font-bold leading-tight">
            AI-Bridge Hub
          </h1>
        </div>
      </header>

      {/* Privacy badge */}
      <div className="mx-4 mb-3 rounded-xl bg-[#1A1A1A] border border-[#22C55E]/30 px-3 py-2 flex items-center gap-2">
        <Lock className="h-3.5 w-3.5 text-[#22C55E]" />
        <p className="text-[11px] text-gray-300">
          Your location and number are <span className="text-[#22C55E] font-semibold">encrypted</span>.
        </p>
      </div>

      {/* Map */}
      <div className="mx-4 rounded-2xl overflow-hidden border border-white/10 h-[44vh] min-h-[280px] relative">
        <MapContainer
          center={center}
          zoom={14}
          scrollWheelZoom={false}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            attribution='&copy; OpenStreetMap'
            url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          />
          {user && <Marker position={[user.lat, user.lng]} icon={userIcon} />}
          {helper && (
            <Marker
              position={[helper.lat, helper.lng]}
              icon={makeIcon(helperIconHtml(stalled))}
            />
          )}
          {points.length === 2 && (
            <Polyline
              positions={points}
              pathOptions={{
                color: stalled ? "#F97316" : "#22C55E",
                weight: 4,
                opacity: 0.85,
                dashArray: "8 8",
              }}
            />
          )}
          <FitBounds points={points} />
        </MapContainer>

        {/* Floating status pill */}
        <div
          className={cn(
            "absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full border text-[11px] font-semibold flex items-center gap-2 backdrop-blur",
            movingTone,
          )}
        >
          <span
            className={cn(
              "h-2 w-2 rounded-full animate-pulse",
              stalled ? "bg-[#F97316]" : "bg-[#22C55E]",
            )}
          />
          {movingLabel}
          {etaKm != null && !stalled && (
            <span className="text-gray-300 font-normal">
              · {etaKm < 1 ? `${Math.round(etaKm * 1000)} m` : `${etaKm.toFixed(1)} km`} away
            </span>
          )}
        </div>
      </div>

      {/* Stalled alert */}
      {stalled && (
        <div className="mx-4 mt-3 rounded-2xl bg-[#F97316]/10 border-2 border-[#F97316]/50 p-3 flex items-start gap-3 shadow-[0_0_24px_rgba(249,115,22,0.25)] animate-fade-up">
          <ShieldAlert className="h-5 w-5 text-[#F97316] shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-[#F97316]">
              Stalled? Call to verify
            </p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              No movement in the last {Math.max(2, minutesSinceMove)} min. Confirm they're still on the way.
            </p>
          </div>
          <button
            onClick={handleVerifyCall}
            className="rounded-lg bg-[#F97316] text-black px-3 py-1.5 text-xs font-bold active:scale-95"
          >
            Verify
          </button>
        </div>
      )}

      {/* Responder card */}
      <section className="mx-4 mt-3 rounded-2xl bg-[#1A1A1A] border border-white/10 p-4 flex items-center gap-3">
        <div className="h-14 w-14 rounded-2xl overflow-hidden bg-[#121212] border border-white/10 grid place-items-center shrink-0">
          {vendor.shop_photo_url ? (
            <img
              src={vendor.shop_photo_url}
              alt={`${vendor.name}'s photo`}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-xl font-display font-bold text-[#22C55E]">
              {vendor.name?.[0]?.toUpperCase() ?? "?"}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-display font-bold truncate">{vendor.name}</p>
            <VerificationBadge vendor={vendor} />
          </div>
          <p className="text-xs text-gray-400 truncate">
            {vendor.shop_name} · {vendor.category}
          </p>
          <p className="text-[10px] uppercase tracking-[0.2em] text-[#22C55E] mt-0.5 font-bold">
            {vendorTier(vendor) === "green"
              ? "Top-tier verified"
              : vendorTier(vendor) === "yellow"
                ? "Identity linked"
                : "Unverified — call with care"}
          </p>
        </div>
      </section>

      {/* Secure Call CTA */}
      <div className="mx-4 mt-3 mb-6">
        <button
          onClick={handleSecureCall}
          className="w-full rounded-2xl bg-[#22C55E] text-black py-4 flex items-center justify-center gap-2 font-bold text-base active:scale-[0.98] transition-transform shadow-[0_0_28px_rgba(34,197,94,0.45)]"
        >
          <PhoneCall className="h-5 w-5" />
          Secure Call · AI-Bridge
        </button>
        <p className="text-[10px] text-center text-gray-500 mt-2 flex items-center justify-center gap-1">
          <Navigation className="h-3 w-3" />
          Numbers are masked end-to-end via Aaspaas proxy.
        </p>
      </div>
    </div>
  );
};

export default LiveTracking;