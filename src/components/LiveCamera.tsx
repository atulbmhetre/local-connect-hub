import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCw, MapPin } from "lucide-react";
import { toast } from "sonner";

export type CapturedShot = {
  blob: Blob;
  dataUrl: string;
  coords: { lat: number; lng: number };
  takenAt: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCapture: (shot: CapturedShot) => void;
};

/**
 * Live-only shop photo capture.
 * - Uses getUserMedia with `facingMode: environment` (rear camera).
 * - No <input type="file"> fallback — gallery uploads are intentionally disabled.
 * - Captures a fresh GPS fix at the moment of shutter so it can't be spoofed
 *   from an old reading.
 */
export const LiveCamera = ({ open, onClose, onCapture }: Props) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const start = async () => {
      setError(null);
      setReady(false);
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Camera not supported on this device.");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
          setReady(true);
        }
      } catch (e: any) {
        setError(
          e?.name === "NotAllowedError"
            ? "Camera permission denied. Enable it in browser settings."
            : "Couldn't open the camera.",
        );
      }
    };
    start();

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [open]);

  const shoot = async () => {
    if (!videoRef.current || !ready) return;
    setBusy(true);
    try {
      // 1. Get a fresh GPS fix — no cache.
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!("geolocation" in navigator)) {
          reject(new Error("Geolocation not supported"));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 0,
        });
      });

      // 2. Snap the frame.
      const video = videoRef.current;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0);
      const blob: Blob = await new Promise((res) =>
        canvas.toBlob((b) => res(b!), "image/jpeg", 0.85),
      );
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

      onCapture({
        blob,
        dataUrl,
        coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        takenAt: new Date().toISOString(),
      });
    } catch (e: any) {
      toast.error("Couldn't capture", {
        description: e?.message ?? "Make sure GPS and camera are enabled.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 grid place-items-center p-4">
      <div className="w-full max-w-md flex flex-col rounded-3xl bg-card border border-border shadow-card overflow-hidden max-h-[min(90vh,920px)]">
        {/* Full-width top bar — never covered by viewfinder overlays so Cancel always receives clicks */}
        <div className="flex shrink-0 items-center justify-between gap-3 bg-page-bg px-4 py-3 border-b border-white/10">
          <div className="min-w-0 flex items-start gap-2">
            <MapPin className="h-4 w-4 text-brand shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-[10px] uppercase tracking-[0.25em] text-gray-400">
                Live Shop Photo
              </p>
              <p className="text-sm font-medium text-white">GPS will be captured at shutter</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            aria-label="Cancel"
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-semibold text-white hover:bg-white/10 transition-colors"
          >
            ✕ Cancel
          </button>
        </div>

        <div className="relative aspect-[4/3] bg-black shrink-0">
          <video
            ref={videoRef}
            playsInline
            muted
            className="h-full w-full object-cover"
          />
          {!ready && !error && (
            <div className="absolute inset-0 z-[1] grid place-items-center bg-black/50 text-white pointer-events-none">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-[2] grid place-items-center p-6 text-center bg-black/80 text-white">
              <div>
                <p className="font-semibold">{error}</p>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="mt-3 inline-flex items-center gap-1 text-sm underline"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Close & retry
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 space-y-2 shrink-0 bg-card">
          <button
            disabled={!ready || busy}
            onClick={shoot}
            className="w-full rounded-2xl bg-primary text-primary-foreground py-4 font-semibold flex items-center justify-center gap-2 disabled:opacity-60 active:scale-[0.98]"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Camera className="h-5 w-5" />}
            Capture & Verify GPS
          </button>
          <p className="text-[11px] text-center text-muted-foreground">
            Live capture only. Gallery uploads are disabled to prevent fraud.
          </p>
        </div>
      </div>
    </div>
  );
};
