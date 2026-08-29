import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import { requestPhoneOtp, verifyPhoneOtp } from "@/lib/userIdentity";
import { cn } from "@/lib/utils";

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

  const sendOtp = useCallback(async () => {
    setRequesting(true);
    setRequestError(null);
    const result = await requestPhoneOtp(phone);
    setRequesting(false);
    if (!result.success) {
      const msg = result.error ?? "OTP request failed";
      setRequestError(msg);
      onRequestFailed?.(msg);
    }
  }, [phone, onRequestFailed]);

  useEffect(() => {
    if (!requestOnMount) return;
    void sendOtp();
  }, [requestOnMount, sendOtp]);

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
    } else {
      setOtpError(s.firstopen_otp_wrong);
    }
  };

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

      {otpError && <p className="text-sm text-destructive text-center">{otpError}</p>}

      <button
        type="button"
        data-testid="otp-verify-btn"
        onClick={() => void handleVerify()}
        disabled={otpLoading || otpValue.length !== 6}
        className="w-full py-3 rounded-xl bg-brand text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {otpLoading && <Loader2 className="animate-spin w-4 h-4" />}
        {s.firstopen_otp_verify}
      </button>

      {requestError && (
        <button
          type="button"
          data-testid="otp-resend-btn"
          onClick={() => void sendOtp()}
          className="text-sm text-muted-foreground underline text-center"
        >
          {s.network_retry_btn}
        </button>
      )}
    </div>
  );
}
