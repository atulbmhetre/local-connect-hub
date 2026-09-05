import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { requestPhoneOtp, verifyPhoneOtp } from "@/lib/userIdentity";
import { classifyOtpVerifyError, OTP_RESEND_COOLDOWN_MS } from "@/lib/otpVerify";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
  phone: string;
  onVerified: () => void;
  /** When false, caller must invoke requestPhoneOtp before showing this UI. */
  requestOnMount?: boolean;
  onRequestFailed?: (error: string) => void;
  className?: string;
};

/**
 * Shared OTP entry UI — used by FirstOpen, PhoneEntrySheet, VendorMode, etc.
 * Skip is intentionally not offered here; restore skip lives on the pre-SMS choice screen.
 */
export function PhoneOtpVerification({
  phone,
  onVerified,
  requestOnMount = true,
  onRequestFailed,
  className,
}: Props) {
  const { s } = useLanguage();
  const [otpValue, setOtpValue] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(requestOnMount);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState<number | null>(null);
  const [resendSecondsLeft, setResendSecondsLeft] = useState(0);

  const armResendCooldown = useCallback(() => {
    setResendAvailableAt(Date.now() + OTP_RESEND_COOLDOWN_MS);
  }, []);

  useEffect(() => {
    if (resendAvailableAt == null) {
      setResendSecondsLeft(0);
      return;
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000));
      setResendSecondsLeft(left);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [resendAvailableAt]);

  const sendOtp = useCallback(async () => {
    setRequesting(true);
    setRequestError(null);
    setOtpError(null);
    const result = await requestPhoneOtp(phone);
    setRequesting(false);
    if (!result.success) {
      const msg = result.error ?? "OTP request failed";
      setRequestError(msg);
      // Failed send: allow immediate retry (same as prior behaviour).
      setResendAvailableAt(Date.now());
      onRequestFailed?.(msg);
      return;
    }
    armResendCooldown();
  }, [phone, onRequestFailed, armResendCooldown]);

  useEffect(() => {
    if (!requestOnMount) {
      // Caller already sent — still arm cooldown so resend is available after wait.
      armResendCooldown();
      return;
    }
    void sendOtp();
  }, [requestOnMount, sendOtp, armResendCooldown]);

  const handleVerify = async () => {
    const token = otpValue.trim();
    if (token.length !== 6 || !/^\d{6}$/.test(token)) {
      setOtpError(s.firstopen_otp_invalid);
      return;
    }
    setOtpLoading(true);
    setOtpError(null);
    const result = await verifyPhoneOtp(phone, token);
    setOtpLoading(false);
    if (result.success) {
      onVerified();
      return;
    }
    const kind = classifyOtpVerifyError(result.error);
    setOtpError(
      kind === "expired" ? s.firstopen_otp_expired : s.firstopen_otp_wrong,
    );
  };

  const canResend = resendSecondsLeft <= 0 && !otpLoading && !requesting;

  if (requesting) {
    return (
      <div
        className={cn("flex flex-col items-center justify-center gap-3 py-8", className)}
        data-testid="otp-screen"
      >
        <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden />
        <p className="text-sm text-muted-foreground">{s.phone_entry_checking}</p>
      </div>
    );
  }

  return (
    <div
      className={cn("flex flex-col gap-6", className)}
      data-testid="otp-screen"
    >
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-xl font-semibold">{s.firstopen_otp_title}</h2>
        <p className="text-sm text-muted-foreground">
          {s.firstopen_otp_subtitle.replace("{phone}", phone)}
        </p>
      </div>

      {requestError && (
        <p className="text-sm text-destructive text-center">{requestError}</p>
      )}

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
        <p
          className="text-sm text-destructive text-center"
          data-testid="otp-error"
        >
          {otpError}
        </p>
      )}

      <Button
        type="button"
        size="lg"
        data-testid="otp-verify-btn"
        onClick={() => void handleVerify()}
        disabled={otpLoading || otpValue.length !== 6}
        className="w-full bg-brand text-white"
      >
        {otpLoading && <Loader2 className="animate-spin w-4 h-4" />}
        {s.firstopen_otp_verify}
      </Button>

      <button
        type="button"
        data-testid="otp-resend-btn"
        onClick={() => void sendOtp()}
        disabled={!canResend}
        className="text-sm text-muted-foreground underline text-center disabled:no-underline disabled:opacity-60"
      >
        {canResend
          ? s.firstopen_otp_resend
          : s.firstopen_otp_resend_in(resendSecondsLeft)}
      </button>
    </div>
  );
}
