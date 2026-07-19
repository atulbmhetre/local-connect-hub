import { useState } from "react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { PushNotifications } from "@capacitor/push-notifications";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";

const ONBOARDED_KEY = "aaspaas:vendor_onboarded";
const TOTAL_STEPS = 5;

type VendorOnboardingProps = {
  onComplete: () => void;
};

export function isVendorOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) === "true";
}

export function VendorOnboarding({ onComplete }: VendorOnboardingProps) {
  const { s } = useLanguage();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  if (!Capacitor.isNativePlatform()) {
    return null;
  }

  const steps = [
    {
      icon: "🔔",
      title: s.onboard_notifications_title,
      body: s.onboard_notifications_body,
      action: s.onboard_allow_notifications,
      skip: s.onboard_skip,
      onAction: async () => {
        setBusy(true);
        try {
          await PushNotifications.requestPermissions();
        } catch {
          /* permission prompt best-effort */
        } finally {
          setBusy(false);
          setStep(2);
        }
      },
    },
    {
      icon: "📍",
      title: s.onboard_location_title,
      body: s.onboard_location_body,
      action: s.onboard_allow_location,
      skip: s.onboard_skip,
      onAction: async () => {
        setBusy(true);
        try {
          await new Promise<void>((resolve, reject) => {
            if (!("geolocation" in navigator)) {
              reject(new Error("unsupported"));
              return;
            }
            navigator.geolocation.getCurrentPosition(
              () => resolve(),
              () => resolve(),
              { enableHighAccuracy: true, timeout: 15000, maximumAge: 60_000 },
            );
          });
        } catch {
          /* best-effort */
        } finally {
          setBusy(false);
          setStep(3);
        }
      },
    },
    {
      icon: "⚡",
      title: s.onboard_battery_title,
      body: s.onboard_battery_body,
      action: s.onboard_open_settings,
      skip: s.onboard_battery_skip,
      onAction: async () => {
        setBusy(true);
        try {
          await App.openUrl({ url: "package:com.aaspaas.pro" });
        } catch {
          /* best-effort */
        } finally {
          setBusy(false);
          setStep(4);
        }
      },
    },
    {
      icon: "📷",
      title: s.onboard_camera_title,
      body: s.onboard_camera_body,
      action: s.onboard_allow_camera,
      skip: s.onboard_skip,
      onAction: async () => {
        setBusy(true);
        try {
          await Camera.getPhoto({
            resultType: CameraResultType.DataUrl,
            source: CameraSource.Camera,
            quality: 50,
          });
        } catch {
          /* permission prompt best-effort */
        } finally {
          setBusy(false);
          setStep(5);
        }
      },
    },
    {
      icon: "✅",
      title: s.onboard_done_title,
      body: s.onboard_done_body,
      action: s.onboard_get_started,
      skip: null as string | null,
      onAction: async () => {
        localStorage.setItem(ONBOARDED_KEY, "true");
        onComplete();
      },
    },
  ];

  const current = steps[step - 1];

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-page-bg text-white" data-testid="vendor-onboarding">
      <div className="px-6 pt-10 pb-4">
        <div className="flex gap-2">
          {Array.from({ length: TOTAL_STEPS }, (_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i < step ? "bg-brand" : "bg-surface-border"
              }`}
            />
          ))}
        </div>
        <p className="text-[11px] text-gray-500 mt-3 tabular-nums" data-testid="vendor-onboarding-step">
          {step} / {TOTAL_STEPS}
        </p>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
        <span className="text-6xl mb-6" aria-hidden>
          {current.icon}
        </span>
        <h2 className="font-display text-2xl font-bold mb-3">{current.title}</h2>
        <p className="text-sm text-gray-400 leading-relaxed max-w-sm">{current.body}</p>
      </div>

      <div className="px-6 pb-10 space-y-3">
        <button
          type="button"
          disabled={busy}
          data-testid="vendor-onboarding-action"
          onClick={() => void current.onAction()}
          className="w-full rounded-xl bg-brand text-page-bg py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : current.action}
        </button>
        {current.skip && (
          <button
            type="button"
            disabled={busy}
            data-testid="vendor-onboarding-skip"
            onClick={() => setStep((prev) => Math.min(prev + 1, TOTAL_STEPS))}
            className="w-full text-sm text-gray-500 py-2 hover:text-gray-300 disabled:opacity-50"
          >
            {current.skip}
          </button>
        )}
      </div>
    </div>
  );
}
