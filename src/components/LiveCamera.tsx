import { useEffect, useState } from "react";
import { App } from "@capacitor/app";
import {
  Camera as CapacitorCamera,
  CameraDirection,
  CameraResultType,
  CameraSource,
} from "@capacitor/camera";

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
  /** Defaults to rear (shop photos). Use front for selfie capture. */
  facing?: "front" | "rear";
  /** When false, skips GPS (e.g. selfie). Defaults to true. */
  requireLocation?: boolean;
};

/**
 * Live-only shop photo capture via native camera.
 * No visible UI while the plugin is opening; error UI only on failure.
 */
export const LiveCamera = ({
  open,
  onClose,
  onCapture,
  facing = "rear",
  requireLocation = true,
}: Props) => {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setError(null);
      return;
    }
    let cancelled = false;

    const launchCamera = async () => {
      setError(null);
      try {
        const photo = await CapacitorCamera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Camera,
          direction: facing === "front" ? CameraDirection.Front : CameraDirection.Rear,
        });

        if (cancelled) return;
        if (!photo.dataUrl) {
          setError("Couldn't capture a photo.");
          return;
        }

        let coords = { lat: 0, lng: 0 };
        if (requireLocation) {
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
          coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        }

        const blob = await fetch(photo.dataUrl).then((r) => r.blob());
        onCapture({
          blob,
          dataUrl: photo.dataUrl,
          coords,
          takenAt: new Date().toISOString(),
        });
        onClose();
      } catch (e: unknown) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e ?? "");
        const lowered = message.toLowerCase();
        if (lowered.includes("cancelled") || lowered.includes("user cancelled")) {
          onClose();
          return;
        }
        setError(message || "Camera access failed. Please allow camera permission.");
      }
    };
    void launchCamera();

    return () => {
      cancelled = true;
    };
  }, [open, onCapture, onClose, facing, requireLocation]);

  if (!open) return null;

  if (error) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/90 grid place-items-center p-4">
        <div className="w-full max-w-xs text-center text-white">
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
              onClick={onClose}
              className="w-full rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] bg-transparent pointer-events-none"
      aria-hidden
    />
  );
};
