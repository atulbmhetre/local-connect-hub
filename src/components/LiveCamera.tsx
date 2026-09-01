import { useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  Camera as CapacitorCamera,
  CameraDirection,
  CameraResultType,
  CameraSource,
} from "@capacitor/camera";
import { useLanguage } from "@/lib/language";
import { ensureNativePermission, isPermissionGranted } from "@/lib/nativePermissions";

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
  /**
   * Camera-only for verification photos. Prompt (camera or gallery) for
   * non-verification captures such as menu item photos.
   */
  source?: CameraSource;
};

const E2E_MOCK_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFfgH/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//Z";

function isE2eCameraMock(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as unknown as { __E2E_MOCK_CAMERA__?: boolean }).__E2E_MOCK_CAMERA__ === true
  );
}

/**
 * Live-only shop/selfie photo capture.
 * Native: Capacitor Camera plugin. Web verification: getUserMedia live preview
 * (no gallery upload). Prompt source still uses the plugin for gallery picks.
 */
export const LiveCamera = ({
  open,
  onClose,
  onCapture,
  facing = "rear",
  requireLocation = true,
  source = CameraSource.Camera,
}: Props) => {
  const { s } = useLanguage();
  const [error, setError] = useState<string | null>(null);
  const [webReady, setWebReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);

  const useWebLiveCapture =
    open && !isE2eCameraMock() && !Capacitor.isNativePlatform() && source === CameraSource.Camera;

  const stopWebStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const resolveCoords = async (): Promise<CapturedShot["coords"]> => {
    if (!requireLocation) {
      return { lat: 0, lng: 0, accuracy: null };
    }
    const e2eGeo =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              __E2E_MOCK_GEO__?: { lat: number; lng: number; accuracy?: number | null };
            }
          ).__E2E_MOCK_GEO__
        : undefined;
    if (e2eGeo && Number.isFinite(e2eGeo.lat) && Number.isFinite(e2eGeo.lng)) {
      return {
        lat: e2eGeo.lat,
        lng: e2eGeo.lng,
        accuracy:
          e2eGeo.accuracy != null && Number.isFinite(e2eGeo.accuracy) ? e2eGeo.accuracy : null,
      };
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
    const acc = pos.coords.accuracy;
    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: acc != null && Number.isFinite(acc) && acc >= 0 ? acc : null,
    };
  };

  const finishWithDataUrl = async (dataUrl: string) => {
    if (cancelledRef.current) return;
    const coords = await resolveCoords();
    if (cancelledRef.current) return;
    const blob = await fetch(dataUrl).then((r) => r.blob());
    onCapture({
      blob,
      dataUrl,
      coords,
      takenAt: new Date().toISOString(),
    });
    onClose();
  };

  const captureWebFrame = async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) {
      setError(s.camera_capture_failed);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError(s.camera_capture_failed);
      return;
    }
    ctx.drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    stopWebStream();
    try {
      await finishWithDataUrl(dataUrl);
    } catch (e: unknown) {
      if (cancelledRef.current) return;
      const message = e instanceof Error ? e.message : String(e ?? "");
      setError(message || s.camera_capture_failed);
    }
  };

  useEffect(() => {
    if (!open) {
      setError(null);
      setWebReady(false);
      stopWebStream();
      return;
    }
    cancelledRef.current = false;
    let cancelled = false;

    const launchPluginCamera = async () => {
      setError(null);
      try {
        const e2eMock = isE2eCameraMock();
        let dataUrl: string | undefined;
        if (e2eMock) {
          dataUrl = E2E_MOCK_JPEG;
        } else {
          if (Capacitor.isNativePlatform()) {
            const cam = await ensureNativePermission("camera", "explicit");
            if (!isPermissionGranted(cam)) {
              setError(s.camera_access_failed);
              return;
            }
          }
          const photo = await CapacitorCamera.getPhoto({
            quality: 85,
            allowEditing: false,
            resultType: CameraResultType.DataUrl,
            source,
            direction: facing === "front" ? CameraDirection.Front : CameraDirection.Rear,
          });
          dataUrl = photo.dataUrl;
        }

        if (cancelled || cancelledRef.current) return;
        if (!dataUrl) {
          setError(s.camera_capture_failed);
          return;
        }
        await finishWithDataUrl(dataUrl);
      } catch (e: unknown) {
        if (cancelled || cancelledRef.current) return;
        const message = e instanceof Error ? e.message : String(e ?? "");
        const lowered = message.toLowerCase();
        if (lowered.includes("cancelled") || lowered.includes("user cancelled")) {
          onClose();
          return;
        }
        setError(message || s.camera_access_failed);
      }
    };

    const startWebLive = async () => {
      setError(null);
      setWebReady(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing === "front" ? "user" : "environment" },
          audio: false,
        });
        if (cancelled || cancelledRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          try {
            video.srcObject = stream;
            await video.play();
          } catch {
            // Autoplay / fake streams can fail in tests/headless; keep the live track.
          }
        }
        if (cancelled || cancelledRef.current) {
          stopWebStream();
          return;
        }
        setWebReady(true);
      } catch (e: unknown) {
        if (cancelled || cancelledRef.current) return;
        const message = e instanceof Error ? e.message : String(e ?? "");
        setError(message || s.camera_access_failed);
      }
    };

    if (isE2eCameraMock() || Capacitor.isNativePlatform() || source !== CameraSource.Camera) {
      void launchPluginCamera();
    } else {
      void startWebLive();
    }

    return () => {
      cancelled = true;
      cancelledRef.current = true;
      stopWebStream();
    };
    // finishWithDataUrl / s are stable enough for this open-gated effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- relaunch only when the capture session opens
  }, [open, onCapture, onClose, facing, requireLocation, source, s]);

  if (!open) return null;

  if (error) {
    return (
      <div className="fixed inset-0 z-[100] bg-black/90 grid place-items-center p-4">
        <div className="w-full max-w-xs text-center text-white">
          <p className="font-semibold">{error}</p>
          <div className="mt-4 space-y-2">
            {Capacitor.isNativePlatform() && (
              <button
                type="button"
                onClick={() => void App.openUrl({ url: "app-settings:" })}
                className="w-full rounded-xl bg-primary text-primary-foreground px-4 h-10 text-sm font-semibold"
              >
                {s.camera_go_to_settings}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-xl border border-white/20 px-4 h-10 text-sm font-semibold"
            >
              {s.camera_cancel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (useWebLiveCapture) {
    return (
      <div
        className="fixed inset-0 z-[100] bg-black flex flex-col"
        data-testid="live-camera-web"
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={
            facing === "front"
              ? "min-h-0 flex-1 w-full object-cover -scale-x-100"
              : "min-h-0 flex-1 w-full object-cover"
          }
        />
        <div className="shrink-0 p-4 space-y-2 bg-black/80">
          <button
            type="button"
            data-testid="live-camera-web-shutter"
            disabled={!webReady}
            onClick={() => void captureWebFrame()}
            className="w-full rounded-xl bg-primary text-primary-foreground px-4 h-12 text-sm font-semibold disabled:opacity-50"
          >
            {facing === "front" ? s.vendor_selfie_capture : s.camera_take_photo}
          </button>
          <button
            type="button"
            onClick={() => {
              stopWebStream();
              onClose();
            }}
            className="w-full rounded-xl border border-white/20 px-4 h-10 text-sm font-semibold text-white"
          >
            {s.camera_cancel}
          </button>
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
