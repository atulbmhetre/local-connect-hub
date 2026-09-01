import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Lock,
  PhoneCall,
  ShieldAlert,
  Loader2,
  AlertTriangle,
  Flashlight,
  Share2,
} from "lucide-react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { supabase, invokeInitiateCall, useCategoryLabel, type Vendor, distanceKm } from "@/lib/supabase";
import { fetchVendorsVisibleToCustomer } from "@/lib/vendorRead";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { vendorTier } from "@/components/VerificationBadge";
import { TrustBadge } from "@/components/TrustBadge";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
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
import { useLanguage } from "@/lib/language";
import { useAppConfig } from "@/hooks/useAppConfig";
import { toast } from "sonner";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  NetworkExhaustedError,
  withNetworkRetry,
} from "@/lib/withNetworkRetry";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import { SecureCallPreDialOverlay } from "@/components/SecureCallPreDialOverlay";
import { fetchBusinessPhotos, resolveVendorPhoto } from "@/lib/businessPhotoFallback";

// Stalled threshold: if helper coords don't move for 2 minutes, alert.
const STALL_MS = 2 * 60 * 1000;

// Average urban responder speed used to derive an ETA from straight-line km.
const AVG_SPEED_KMH = 28;

/** Match AiBridgeSheet: after Exotel accepts, show brief "ringing on your phone" then dismiss. */
const SECURE_CALL_SUCCESS_DISMISS_MS = 3000;

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
  const color = stalled ? "#F97316" : "var(--color-brand)";
  const glow = stalled ? "rgba(249,115,22,0.65)" : "color-mix(in srgb, var(--color-brand) 70%, transparent)";
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
  const [searchParams] = useSearchParams();
  const queryCategoryId = searchParams.get("categoryId") || searchParams.get("category_id");
  const [orderCategoryId, setOrderCategoryId] = useState<string | null>(queryCategoryId);
  const [businessBrand, setBusinessBrand] = useState<string | null>(null);
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const getLabel = useCategoryLabel();
  const secureCallingLive = config.exotelSecureCallingEnabled;

  const [vendor, setVendor] = useState<Vendor | null>(null);
  const [loading, setLoading] = useState(true);
  const [networkLoadStatus, setNetworkLoadStatus] = useState<"retrying" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<{ lat: number; lng: number } | null>(null);
  const [helper, setHelper] = useState<{ lat: number; lng: number } | null>(null);

  // Track movement to detect stalls.
  const lastMoveRef = useRef<number>(Date.now());
  const lastCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const [stalled, setStalled] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [businessPhotos, setBusinessPhotos] = useState<Map<string, string | null>>(new Map());

  // Secure call: pre-dial overlay → initiate-call → post-success ringing overlay.
  const [callPhase, setCallPhase] = useState<"idle" | "predial" | "ringing">("idle");
  const [directCallConfirmOpen, setDirectCallConfirmOpen] = useState(false);

  // Flash LED signal (torch) state.
  const [flashing, setFlashing] = useState(false);
  const torchTrackRef = useRef<MediaStreamTrack | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  const fetchVendor = useCallback(async () => {
    if (!vendorId) return;
    setLoading(true);
    setNetworkLoadStatus(null);
    setError(null);
    try {
      const { data: rows, error: fetchError } = await withNetworkRetry(
        async () => {
          const visible = await fetchVendorsVisibleToCustomer([vendorId], {
            userPhone: getUserPhone(),
            deviceId: getDeviceId(),
          });
          if (visible.error) throw visible.error;
          const row = visible.data[0] ?? null;
          return { data: row, error: null };
        },
        {
          onRetrying: () => setNetworkLoadStatus("retrying"),
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      if (fetchError) {
        captureError(fetchError, { scope: "liveTracking.fetchVendor", vendorId });
        setError(fetchError.message);
        return;
      }
      if (!rows) {
        setError(s.liveTracking_responderGone);
        return;
      }
      const v = rows as Vendor;
      setVendor(v);
      if (v.latitude != null && v.longitude != null) {
        const h = { lat: v.latitude, lng: v.longitude };
        setHelper(h);
        lastCoordsRef.current = h;
        lastMoveRef.current = Date.now();
      }
    } catch (e: unknown) {
      if (e instanceof NetworkExhaustedError) {
        setNetworkLoadStatus("failed");
      } else {
        captureError(e, { scope: "liveTracking.fetchVendor", vendorId });
        setError(e instanceof Error ? e.message : s.liveTracking_loadError);
      }
    } finally {
      setLoading(false);
    }
  }, [vendorId, s]);

  useEffect(() => {
    if (queryCategoryId) {
      setOrderCategoryId(queryCategoryId);
      return;
    }
    if (!vendorId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc("get_my_orders", {
        p_user_phone: getUserPhone(),
        p_device_id: getDeviceId(),
      });
      if (cancelled || error) return;
      const match = (data ?? []).find(
        (row: { vendor_id?: string; category_id?: string | null }) =>
          row.vendor_id === vendorId && row.category_id,
      );
      if (match?.category_id) setOrderCategoryId(String(match.category_id));
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId, queryCategoryId]);

  useEffect(() => {
    if (!vendorId || !orderCategoryId) {
      setBusinessBrand(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("vendor_categories")
        .select("brand_name")
        .eq("vendor_id", vendorId)
        .eq("category_id", orderCategoryId)
        .maybeSingle();
      if (cancelled) return;
      const brand = String(data?.brand_name ?? "").trim();
      setBusinessBrand(brand || null);
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId, orderCategoryId]);

  // Fetch vendor + initial helper coords.
  useEffect(() => {
    void fetchVendor();
  }, [fetchVendor]);

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

  // Fetch business-specific photos when vendor and category are available
  useEffect(() => {
    if (!vendor || !orderCategoryId) {
      return;
    }

    void fetchBusinessPhotos([{ vendorId: vendor.id, categoryId: orderCategoryId }]).then(
      (photoMap) => setBusinessPhotos(photoMap)
    );
  }, [vendor?.id, orderCategoryId]);

  // After Exotel accepts: brief overlay, then dismiss (call continues on the phone).
  useEffect(() => {
    if (callPhase !== "ringing") return;
    const t = window.setTimeout(() => {
      setCallPhase("idle");
    }, SECURE_CALL_SUCCESS_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [callPhase]);

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

  const vendorDisplayName = vendor?.name?.trim() || vendor?.shop_name || s.liveTracking_vendorFallback;

  const openDirectTel = () => {
    const phone = vendor?.phone?.replace(/[\s\-+]/g, "").trim();
    if (!phone) {
      toast.error(s.ai_bridge_call_failed);
      return;
    }
    window.open(`tel:${phone}`, "_self");
  };

  const handleSecureCall = async () => {
    if (!vendor) return;
    if (!secureCallingLive) {
      toast(s.secure_call_coming_soon);
      return;
    }

    const caller = (getUserPhone() ?? "").replace(/[\s\-+]/g, "").trim();
    const vendorPhone = vendor.phone.replace(/[\s\-+]/g, "").trim();
    if (!caller || !vendorPhone) {
      toast.error(s.ai_bridge_call_failed);
      setDirectCallConfirmOpen(true);
      return;
    }

    setCallPhase("predial");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const result = await invokeInitiateCall({
      caller_phone: caller,
      vendor_phone: vendorPhone,
      service_mode: vendor.service_mode ?? "help",
    });

    if (!result.success) {
      setCallPhase("idle");
      setDirectCallConfirmOpen(true);
      return;
    }

    setCallPhase("ringing");
    toast(s.secure_call_connected, {
      description: s.secure_call_connected_body.replace("{name}", vendorDisplayName),
    });
  };

  const handleVerifyCall = () => {
    if (!vendor) return;
    void handleSecureCall();
  };

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
      } catch {
        void 0;
      }
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
          } catch {
            void 0;
          }
        }, 500);
        toast(s.liveTracking_flashActive, {
          description: s.liveTracking_flashActiveBody,
        });
        return;
      } else {
        track.stop();
      }
    } catch {
      // permission denied or unsupported — fall back below
    }
    // Fallback: pulse the screen white via CSS overlay (toggled by `flashing`).
    toast(s.liveTracking_screenFlashActive, {
      description: s.liveTracking_screenFlashActiveBody,
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
      ? s.liveTracking_shareTextVendor(vendor.name)
      : s.liveTracking_shareTextGeneric;
    try {
      if (navigator.share) {
        await navigator.share({ title: s.liveTracking_shareTitle, text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast(s.liveTracking_linkCopied, {
        description: s.liveTracking_linkCopiedBody,
      });
    } catch {
      toast(s.liveTracking_shareFailed, { description: s.liveTracking_shareFailedBody });
    }
  };

  const movingLabel = stalled
    ? s.liveTracking_stalled
    : helper
      ? s.liveTracking_moving
      : s.liveTracking_locating;

  const movingTone = stalled
    ? "text-orange-500 border-orange-500/40 bg-orange-500/10"
    : "text-green-700 dark:text-brand border-brand/40 bg-brand-muted";

  const etaDistanceLabel =
    etaKm != null
      ? etaKm < 1
        ? s.liveTracking_distanceMeters(String(Math.round(etaKm * 1000)))
        : s.liveTracking_distanceKm(etaKm.toFixed(1))
      : null;

  if (loading) {
    return (
      <div className="min-h-screen bg-page-bg grid place-items-center text-white">
        <div className="flex flex-col items-center gap-2 text-sm text-gray-400 px-6 text-center">
          <Loader2 className="h-4 w-4 animate-spin text-brand" />
          {networkLoadStatus === "retrying"
            ? s.network_retrying
            : s.liveTracking_opening}
        </div>
      </div>
    );
  }

  if (networkLoadStatus === "failed") {
    return (
      <div className="min-h-screen bg-page-bg text-white p-6 flex flex-col gap-4">
        <button
          onClick={() => navigate(-1)}
          className="h-10 w-10 grid place-items-center rounded-full bg-surface border border-white/10"
          aria-label={s.aria_back}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="rounded-2xl bg-destructive/10 border border-destructive/40 p-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-1" />
          <div className="space-y-3">
            <p className="text-sm">{s.network_failed}</p>
            <button
              type="button"
              onClick={() => void fetchVendor()}
              className="rounded-xl bg-card border border-white/10 px-4 py-2 text-sm font-semibold active:scale-[0.98]"
            >
              {s.network_retry_btn}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (error || !vendor) {
    return (
      <div className="min-h-screen bg-page-bg text-white p-6 flex flex-col gap-4">
        <button
          onClick={() => navigate(-1)}
          className="h-10 w-10 grid place-items-center rounded-full bg-surface border border-white/10"
          aria-label={s.aria_back}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="rounded-2xl bg-destructive/10 border border-destructive/40 p-4 flex gap-3">
          <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-1" />
          <p className="text-sm">{error ?? s.liveTracking_responderUnavailable}</p>
        </div>
      </div>
    );
  }

  const minutesSinceMove = Math.floor((now - lastMoveRef.current) / 60_000);

  return (
    <div className="min-h-screen bg-page-bg text-white flex flex-col">
      <style>{`
        @keyframes aaspaasPing {
          0% { transform: scale(0.6); opacity: 0.6; }
          80%, 100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes aaspaasScreenFlash {
          0%, 100% { background: rgba(255,255,255,0); }
          50% { background: rgba(255,255,255,0.95); }
        }
        .aaspaas-flash-overlay {
          position: fixed; inset: 0; pointer-events: none; z-index: 60;
          animation: aaspaasScreenFlash 0.7s ease-in-out infinite;
        }
        .leaflet-container { background: #121212; }
      `}</style>

      {/* Top bar */}
      <header className="px-4 pt-4 pb-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="h-10 w-10 grid place-items-center rounded-full bg-surface border border-white/10"
          aria-label={s.aria_back}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <p className="text-xs uppercase tracking-[0.3em] text-brand font-bold">
            {s.liveTracking_header}
          </p>
          <h1 className="font-display text-base font-bold leading-tight">
            {s.liveTracking_hubTitle}
          </h1>
        </div>
      </header>

      <TrustWarningBanner tier={vendorTier(vendor)} context="tracking" />

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
                color: stalled ? "#F97316" : "var(--color-brand)",
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
              stalled ? "bg-orange-500" : "bg-brand",
            )}
          />
          {stalled
            ? movingLabel
            : etaMin != null
              ? etaMin === 0
                ? s.liveTracking_arrivingNow
                : s.liveTracking_arrivingIn(String(etaMin))
              : movingLabel}
          {etaDistanceLabel != null && !stalled && (
            <span className="text-gray-300 font-normal">· {etaDistanceLabel}</span>
          )}
        </div>
      </div>

      {/* Stalled alert */}
      {stalled && (
        <div className="mx-4 mt-3 rounded-2xl bg-orange-500/10 border-2 border-orange-500/50 p-3 flex items-start gap-3 shadow-[0_0_24px_rgba(249,115,22,0.25)] animate-fade-up">
          <ShieldAlert className="h-5 w-5 text-orange-500 shrink-0 mt-1" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-orange-500">
              {s.liveTracking_stalledTitle}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {s.liveTracking_stalledBody(String(Math.max(2, minutesSinceMove)))}
            </p>
          </div>
          <button
            onClick={() => void handleVerifyCall()}
            disabled={callPhase !== "idle" || !secureCallingLive}
            className="rounded-lg bg-orange-500 text-black px-3 py-1.5 text-xs font-bold active:scale-95 disabled:opacity-50"
          >
            {s.liveTracking_checkBtn}
          </button>
        </div>
      )}

      {/* Responder card */}
      <section className="mx-4 mt-3 rounded-2xl bg-surface border border-white/10 p-4 flex items-center gap-3">
        <div className="h-14 w-14 rounded-2xl overflow-hidden bg-page-bg border border-white/10 grid place-items-center shrink-0">
          {(() => {
            const effectivePhoto = resolveVendorPhoto(
              businessPhotos,
              vendor.id,
              orderCategoryId,
              vendor.shop_photo_url
            );
            return effectivePhoto ? (
              <img
                src={effectivePhoto}
                alt={s.liveTracking_photoAlt(vendor.name)}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-xl font-display font-bold text-brand">
                {vendor.name?.[0]?.toUpperCase() ?? "?"}
              </span>
            );
          })()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="font-display font-bold truncate">{vendor.name}</p>
            <TrustBadge
              vendorId={vendor.id}
              categoryId={orderCategoryId}
              isManualVerified={vendor.is_manual_verified}
            />
          </div>
          <p className="text-xs text-gray-400 truncate">
            {businessBrand || vendor.shop_name} · {getLabel(vendor.category)}
          </p>
          <p className="text-xs uppercase tracking-[0.2em] text-brand mt-1 font-bold">
            {s.liveTracking_readyToHelp}
          </p>
        </div>
      </section>

      {/* Secure Call CTA */}
      <div className="mx-4 mt-3">
        <button
          type="button"
          onClick={() => void handleSecureCall()}
          disabled={callPhase !== "idle" || !secureCallingLive}
          className="w-full rounded-2xl bg-brand text-black h-12 flex items-center justify-center gap-2 font-bold text-base active:scale-[0.98] transition-transform shadow-[0_0_28px_rgba(34,197,94,0.45)] disabled:opacity-60 disabled:active:scale-100"
        >
          {callPhase !== "idle" ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" />
              {callPhase === "ringing" ? s.secure_call_phone_ringing : s.secure_call_predial_title}
            </>
          ) : !secureCallingLive ? (
            <>
              <PhoneCall className="h-5 w-5" />
              {s.secure_call_coming_soon}
            </>
          ) : (
            <>
              <PhoneCall className="h-5 w-5" />
              {s.secure_call_cta}
            </>
          )}
        </button>
        <p className="text-xs text-center text-gray-500 mt-2 flex items-center justify-center gap-1">
          <Lock className="h-3 w-3" />
          {secureCallingLive
            ? s.secure_call_masked_hint
            : s.secure_call_coming_soon}
        </p>
      </div>

      {/* Emergency signal + share row */}
      <div className="mx-4 mt-3 mb-6 grid grid-cols-2 gap-3">
        <button
          onClick={handleFlashSignal}
          className={cn(
            "rounded-2xl border py-3 flex flex-col items-center justify-center gap-1 transition-colors active:scale-[0.98]",
            flashing
              ? "bg-brand/15 border-brand text-green-700 dark:text-brand shadow-[0_0_20px_rgba(34,197,94,0.35)]"
              : "bg-surface border-white/10 text-white hover:border-brand/40",
          )}
        >
          <Flashlight className={cn("h-5 w-5", flashing && "animate-pulse")} />
          <span className="text-xs font-semibold">
            {flashing ? s.liveTracking_flashStopBtn : s.liveTracking_flashBtn}
          </span>
          <span className="text-xs text-gray-500">{s.liveTracking_flashHint}</span>
        </button>
        <button
          onClick={handleShareStatus}
          className="rounded-2xl bg-surface border border-white/10 py-3 flex flex-col items-center justify-center gap-1 active:scale-[0.98] hover:border-brand/40 transition-colors"
        >
          <Share2 className="h-5 w-5 text-brand" />
          <span className="text-xs font-semibold">{s.liveTracking_shareBtn}</span>
          <span className="text-xs text-gray-500">{s.liveTracking_shareHint}</span>
        </button>
      </div>

      {/* Screen-flash fallback overlay */}
      {flashing && !torchTrackRef.current && <div className="aaspaas-flash-overlay" />}

      {callPhase !== "idle" && (
        <SecureCallPreDialOverlay phase={callPhase === "ringing" ? "ringing" : "predial"} />
      )}

      <AlertDialog open={directCallConfirmOpen} onOpenChange={setDirectCallConfirmOpen}>
        <AlertDialogContent className="rounded-2xl border border-border bg-card">
          <AlertDialogHeader>
            <AlertDialogTitle>{s.secure_call_failed_title}</AlertDialogTitle>
            <AlertDialogDescription>
              {s.secure_call_failed_body.replace("{name}", vendorDisplayName)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{s.settings_cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setDirectCallConfirmOpen(false);
                openDirectTel();
              }}
            >
              {s.secure_call_call_directly}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default LiveTracking;
