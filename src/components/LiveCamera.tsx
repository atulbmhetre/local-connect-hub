import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, X, RefreshCw, MapPin } from "lucide-react";
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

  return (
    <div className="fixed inset-0 z-50 bg-foreground/95 grid place-items-center p-4">
      <div className="w-full max-w-md rounded-3xl bg-card border border-border shadow-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-muted-foreground">
              Live Shop Photo
            </p>
            <p className="text-sm font-semibold mt-0.5 inline-flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 text-secondary" />
              GPS will be captured at shutter
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close camera"
            className="h-9 w-9 rounded-full grid place-items-center bg-muted text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="relative aspect-[4/3] bg-foreground">
          <video
            ref={videoRef}
            playsInline
            muted
            className="h-full w-full object-cover"
          />
          {!ready && !error && (
            <div className="absolute inset-0 grid place-items-center text-background">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {error && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-background">
              <div>
                <p className="font-semibold">{error}</p>
                <button
                  onClick={onClose}
                  className="mt-3 inline-flex items-center gap-1 text-sm underline"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Close & retry
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 space-y-2">
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
