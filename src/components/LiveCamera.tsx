import { useEffect, useState } from "react";
import { App } from "@capacitor/app";
import { Camera as CapacitorCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Loader2, MapPin } from "lucide-react";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const launchCamera = async () => {
      setError(null);
      setBusy(true);
      try {
        const photo = await CapacitorCamera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
        });

        if (cancelled) return;
        if (!photo.dataUrl) {
          setError("Couldn't capture a photo.");
          return;
        }

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

        const blob = await fetch(photo.dataUrl).then((r) => r.blob());
        onCapture({
          blob,
          dataUrl: photo.dataUrl,
          coords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
          takenAt: new Date().toISOString(),
        });
        onClose();
      } catch (e: any) {
        if (cancelled) return;
        const message = String(e?.message ?? "");
        const lowered = message.toLowerCase();
        if (lowered.includes("cancelled") || lowered.includes("user cancelled")) {
          onClose();
          return;
        }
        setError(message || "Camera access failed. Please allow camera permission.");
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void launchCamera();

    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const handleCancel = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/90 grid place-items-center p-4">
      <div className="w-full max-w-md flex flex-col rounded-3xl bg-card border border-border shadow-card overflow-hidden max-h-[min(90vh,920px)]">
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

        <div className="relative flex-1 overflow-hidden bg-black">
          {busy && !error ? (
            <div className="absolute inset-0 z-[1] grid place-items-center bg-black/50 text-white pointer-events-none">
              <div className="text-center">
                <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                <p className="mt-2 text-sm">Opening camera...</p>
              </div>
            </div>
          ) : null}
          {error ? (
            <div className="absolute inset-0 z-[2] grid place-items-center p-6 text-center bg-black/85 text-white">
              <div className="w-full max-w-xs">
                <p className="font-semibold">{error}</p>
                <div className="mt-4 space-y-2">
                  <button
                    type="button"
                    onClick={() => void App.openUrl({ url: "app-settings:" })}
                    className="w-full rounded-xl bg-primary text-primary-foreground px-4 py-2.5 text-sm font-semibold"
                  >
                    Go to Settings
                  </button>
                  <button
                    type="button"
                    onClick={handleCancel}
                    className="w-full rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="p-4 space-y-2 shrink-0 bg-card">
          <button
            type="button"
            disabled
            className="w-full rounded-2xl bg-primary text-primary-foreground py-4 font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
          >
            <Loader2 className="h-5 w-5 animate-spin" />
            Opening camera...
          </button>
          <p className="text-[11px] text-center text-muted-foreground">
            Live capture only. Gallery uploads are disabled to prevent fraud.
          </p>
        </div>
      </div>
    </div>
  );
};
