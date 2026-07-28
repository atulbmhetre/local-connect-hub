import { useEffect, useState } from "react";
import { App } from "@capacitor/app";
import {
  Camera as CapacitorCamera,
  CameraDirection,
  CameraResultType,
  CameraSource,
} from "@capacitor/camera";
import { useLanguage } from "@/lib/language";

export type CapturedShot = {
  blob: Blob;
  dataUrl: string;
  coords: { lat: number; lng: number; accuracy: number | null };
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
  const { s } = useLanguage();
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
        const e2eMock =
          typeof window !== "undefined" &&
          (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ ===
            true;

        let dataUrl: string | undefined;
        if (e2eMock) {
          // 1x1 JPEG — Playwright / headless cannot open the native camera.
          dataUrl =
            "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFfgH/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z";
        } else {
          const photo = await CapacitorCamera.getPhoto({
            quality: 85,
            allowEditing: false,
            resultType: CameraResultType.DataUrl,
            source: CameraSource.Camera,
            direction: facing === "front" ? CameraDirection.Front : CameraDirection.Rear,
          });
          dataUrl = photo.dataUrl;
        }

        if (cancelled) return;
        if (!dataUrl) {
          setError(s.camera_capture_failed);
          return;
        }

        let coords: CapturedShot["coords"] = { lat: 0, lng: 0, accuracy: null };
        if (requireLocation) {
          const e2eGeo =
            typeof window !== "undefined"
              ? (
                  window as unknown as {
                    __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
                  }
                ).__E2E_MOCK_GEO__
              : undefined;
          if (e2eGeo && Number.isFinite(e2eGeo.lat) && Number.isFinite(e2eGeo.lng)) {
            coords = {
              lat: e2eGeo.lat,
              lng: e2eGeo.lng,
              accuracy:
                e2eGeo.accuracy != null && Number.isFinite(e2eGeo.accuracy)
                  ? e2eGeo.accuracy
                  : null,
            };
          } else {
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
            const acc = pos.coords.accuracy;
            coords = {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: acc != null && Number.isFinite(acc) && acc >= 0 ? acc : null,
            };
          }
        }

        const blob = await fetch(dataUrl).then((r) => r.blob());
        onCapture({
          blob,
          dataUrl,
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
        setError(message || s.camera_access_failed);
      }
    };
    void launchCamera();

    return () => {
      cancelled = true;
    };
  }, [open, onCapture, onClose, facing, requireLocation, s]);

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
              {s.camera_go_to_settings}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl border border-white/20 px-4 py-2.5 text-sm font-semibold"
            >
              {s.camera_cancel}
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
