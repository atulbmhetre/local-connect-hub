import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import {
  migrateUserPhone,
  requestPhoneOtp,
  restoreVendorSession,
  saveUserPhone,
  verifyPhoneOtp,
} from "@/lib/userIdentity";
import { getDeviceId } from "@/lib/deviceId";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

// Phase D: set to true when Exotel KYC is complete and ExoVerify is live
const OTP_ENABLED = false;

type FlowStep =
  | "chooser"
  | "restore"
  | "otp_pending"
  | "notification_permission"
  | "done";

type Props = {
  onComplete: () => void;
  onVendorRegister?: () => void;
};

function normalizePhoneDigits(raw: string): string {
  const cleaned = raw.replace(/\D/g, "");
  return cleaned.length === 12 && cleaned.startsWith("91")
    ? cleaned.slice(2)
    : cleaned;
}

export function FirstOpenFlow({ onComplete, onVendorRegister }: Props) {
  const { s } = useLanguage();
  const [step, setStep] = useState<FlowStep>("chooser");
  const [phoneValue, setPhoneValue] = useState("");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<string | null>(null);
  const [inlineTone, setInlineTone] = useState<"success" | "error" | "muted">("muted");
  const [otpValue, setOtpValue] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpPhone, setOtpPhone] = useState("");

  const goToNotificationStep = () => {
    if (Capacitor.isNativePlatform()) {
      setStep("notification_permission");
    } else {
      setStep("done");
    }
  };

  useEffect(() => {
    if (step !== "done") return;
    onComplete();
  }, [step, onComplete]);

  const handleRestore = async () => {
    const digits = normalizePhoneDigits(phoneValue);
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
      setInlineMessage(s.vendor_phone_invalid_body);
      setInlineTone("error");
      return;
    }

    setRestoreLoading(true);
    setInlineMessage(null);

    try {
      const [usersResult, vendorsResult] = await Promise.all([
        supabase.rpc("lookup_user_by_phone", { p_phone: digits }),
        supabase
          .from("vendors")
          .select("id, is_active, deletion_requested_at")
          .eq("phone", digits)
          .maybeSingle(),
      ]);

      if (usersResult.error || vendorsResult.error) {
        setInlineMessage(s.firstopen_restore_error);
        setInlineTone("error");
        setRestoreLoading(false);
        return;
      }

      const hasAccount = (usersResult.data?.[0] != null) || vendorsResult.data != null;

      if (hasAccount) {
        setInlineMessage(s.firstopen_restore_found);
        setInlineTone("success");
        saveUserPhone(digits);
        await migrateUserPhone(digits, getDeviceId());

        const vendorRow = vendorsResult.data;
        if (
          vendorRow &&
          vendorRow.is_active === true &&
          vendorRow.deletion_requested_at == null
        ) {
          restoreVendorSession(vendorRow.id);
        }

        setRestoreLoading(false);
        if (OTP_ENABLED) {
          const otpResult = await requestPhoneOtp(digits);
          if (otpResult.success) {
            setOtpPhone(digits);
            setStep("otp_pending");
          } else {
            console.warn('[Phase D] OTP fallback to localStorage path — no Supabase session established');
            console.warn("[Phase B] OTP request failed, falling back:", otpResult.error);
            goToNotificationStep();
          }
        } else {
          goToNotificationStep();
        }
        return;
      }

      setInlineMessage(s.firstopen_no_account);
      setInlineTone("muted");
      setRestoreLoading(false);
      if (OTP_ENABLED) {
        const otpResult = await requestPhoneOtp(digits);
        if (otpResult.success) {
          setOtpPhone(digits);
          setStep("otp_pending");
        } else {
          console.warn('[Phase D] OTP fallback to localStorage path — no Supabase session established');
          console.warn("[Phase B] OTP request failed, falling back:", otpResult.error);
          goToNotificationStep();
        }
      } else {
        goToNotificationStep();
      }
    } catch {
      setInlineMessage(s.firstopen_restore_error);
      setInlineTone("error");
      setRestoreLoading(false);
    }
  };

  const handleVerifyOtp = async () => {
    const token = otpValue.trim();
    if (token.length !== 6 || !/^\d{6}$/.test(token)) {
      setOtpError(s.firstopen_otp_invalid);
      return;
    }
    setOtpLoading(true);
    setOtpError(null);
    const result = await verifyPhoneOtp(otpPhone, token);
    setOtpLoading(false);
    if (result.success) {
      console.info('[Phase D] Supabase session established for phone:', otpPhone);
      goToNotificationStep();
    } else {
      setOtpError(s.firstopen_otp_wrong);
    }
  };

  const handleSkipOtp = () => {
    if (!OTP_ENABLED) return;
    console.warn('[Phase D] OTP fallback to localStorage path — no Supabase session established');
    console.warn("[Phase B] OTP skipped by user");
    goToNotificationStep();
  };

  const handleAllowNotifications = async () => {
    if (!Capacitor.isNativePlatform()) {
      setStep("done");
      return;
    }

    setNotifLoading(true);
    try {
      const permission = await PushNotifications.requestPermissions();
      if (permission.receive === "granted") {
        void PushNotifications.register();
      }
    } catch {
      /* proceed regardless */
    } finally {
      setNotifLoading(false);
      setStep("done");
    }
  };

  if (step === "done") {
    return null;
  }

  return (
    <div
      data-testid="first-open-flow"
      className="fixed inset-0 z-50 flex flex-col bg-background overflow-y-auto"
    >
      {step === "chooser" && (
        <div className="flex flex-1 flex-col justify-center px-6 py-10 max-w-md mx-auto w-full gap-3">
          <button
            type="button"
            data-testid="firstopen-vendor-btn"
            onClick={() => onVendorRegister?.()}
            className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform"
          >
            {s.welcome_register_business}
          </button>
          <button
            type="button"
            data-testid="firstopen-restore-skip"
            onClick={goToNotificationStep}
            className="w-full rounded-xl border border-border py-3.5 text-sm font-semibold text-foreground active:scale-[0.98] transition-transform"
          >
            {s.welcome_skip_registration}
          </button>
          <button
            type="button"
            data-testid="firstopen-restore-entry"
            onClick={() => setStep("restore")}
            className="w-full rounded-xl border border-border py-3.5 text-sm font-semibold text-foreground active:scale-[0.98] transition-transform"
          >
            {s.welcome_restore_account}
          </button>
        </div>
      )}

      {step === "restore" && (
        <div className="flex flex-1 flex-col px-6 py-10 max-w-md mx-auto w-full">
          <h1 className="font-display text-2xl font-bold text-foreground leading-tight">
            {s.firstopen_restore_title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            {s.firstopen_restore_body}
          </p>

          <div className="mt-6 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3">
            <span className="text-sm text-muted-foreground font-medium">+91</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="98765 43210"
              value={phoneValue}
              onChange={(e) => {
                setPhoneValue(e.target.value.replace(/\D/g, "").slice(0, 10));
                setInlineMessage(null);
              }}
              disabled={restoreLoading}
              className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          {inlineMessage && (
            <p
              className={cn(
                "mt-3 text-sm leading-relaxed",
                inlineTone === "success" && "text-brand font-medium",
                inlineTone === "error" && "text-destructive",
                inlineTone === "muted" && "text-muted-foreground",
              )}
            >
              {inlineMessage}
            </p>
          )}

          <button
            type="button"
            data-testid="firstopen-restore-cta"
            disabled={restoreLoading}
            onClick={() => void handleRestore()}
            className="mt-6 w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 flex items-center justify-center gap-2"
          >
            {restoreLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              </>
            ) : (
              s.firstopen_restore_cta
            )}
          </button>

          <button
            type="button"
            data-testid="firstopen-restore-back"
            disabled={restoreLoading}
            onClick={() => {
              setInlineMessage(null);
              setStep("chooser");
            }}
            className="mt-4 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
          >
            {s.firstopen_restore_back}
          </button>
        </div>
      )}

      {/* Phase D: OTP verification is the primary auth path.
          On failure or skip, falls back to localStorage identity (no lockout). */}
      {OTP_ENABLED && step === "otp_pending" && (
        <div
          className="flex flex-col flex-1 justify-center px-6 gap-6"
          data-testid="otp-screen"
        >
          <div className="flex flex-col gap-2 text-center">
            <h2 className="text-xl font-semibold">{s.firstopen_otp_title}</h2>
            <p className="text-sm text-muted-foreground">
              {s.firstopen_otp_subtitle.replace("{phone}", otpPhone)}
            </p>
          </div>

          <input
            data-testid="otp-input"
            type="tel"
            inputMode="numeric"
            maxLength={6}
            value={otpValue}
            onChange={(e) => {
              setOtpValue(e.target.value.replace(/\D/g, ""));
              setOtpError(null);
            }}
            placeholder="------"
            className="text-center text-2xl tracking-[0.5em] border rounded-xl px-4 py-3 w-full bg-background"
            autoFocus
          />

          {otpError && (
            <p className="text-sm text-destructive text-center">{otpError}</p>
          )}

          <button
            type="button"
            data-testid="otp-verify-btn"
            onClick={() => void handleVerifyOtp()}
            disabled={otpLoading || otpValue.length !== 6}
            className="w-full py-3 rounded-xl bg-brand text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {otpLoading && <Loader2 className="animate-spin w-4 h-4" />}
            {s.firstopen_otp_verify}
          </button>

          <button
            type="button"
            data-testid="otp-skip-btn"
            onClick={handleSkipOtp}
            className="text-sm text-muted-foreground underline text-center"
          >
            {s.firstopen_otp_skip}
          </button>
        </div>
      )}

      {step === "notification_permission" && (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 max-w-md mx-auto w-full text-center">
          <p className="text-5xl mb-6" aria-hidden>
            🔔
          </p>
          <h2 className="font-display text-2xl font-bold text-foreground leading-tight">
            {s.firstopen_notif_title}
          </h2>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            {s.firstopen_notif_body}
          </p>

          <button
            type="button"
            data-testid="firstopen-notif-allow"
            disabled={notifLoading}
            onClick={() => void handleAllowNotifications()}
            className="mt-8 w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 flex items-center justify-center gap-2"
          >
            {notifLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              s.firstopen_notif_allow
            )}
          </button>

          <button
            type="button"
            data-testid="firstopen-notif-skip"
            disabled={notifLoading}
            onClick={() => setStep("done")}
            className="mt-4 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
          >
            {s.firstopen_notif_skip}
          </button>
        </div>
      )}
    </div>
  );
}
