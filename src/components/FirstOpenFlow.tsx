import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/language";
import {
  migrateUserPhone,
  restoreVendorSession,
  saveUserPhone,
  getUserPhone,
} from "@/lib/userIdentity";
import { OTP_ENABLED, normalizePhoneDigits, isValidIndianMobile } from "@/lib/phoneOtpEnabled";
import { PhoneOtpVerification } from "@/components/PhoneOtpVerification";
import { getDeviceId } from "@/lib/deviceId";
import {
  registerUserPushToken,
  requestPushPermissionFromOs,
} from "@/lib/pushNotifications";
import { markNotificationSkip } from "@/lib/nativePermissions";
import { setFirstOpenBackHandler } from "@/lib/firstOpenBackBridge";
import { captureError } from "@/lib/sentry";
import { supabase } from "@/lib/supabase";
import {
  applyAbortSignal,
  isNetworkTimeout,
  NetworkExhaustedError,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import { cn } from "@/lib/utils";

/** Temporary mobile restore debug — visible in DEV so phone testing can see hang point without DevTools. */
const RESTORE_DEBUG = import.meta.env.DEV;

type FlowStep =
  | "chooser"
  | "new_options"
  | "register_phone"
  | "restore"
  | "restore_verify_choice"
  | "otp_pending"
  | "notification_permission"
  | "done";

type RegisterIntent = "customer" | "vendor";

type OtpPurpose = "restore" | "restore_new_phone" | "register_customer" | "register_vendor";

type Props = {
  onComplete: () => void;
  onVendorRegister?: () => void;
};

type RestoreDebugLine = { t: string; msg: string };

type VendorRestoreStatus = {
  found: boolean;
  vendor_id: string | null;
  is_banned: boolean;
  is_active: boolean;
  discoverable: boolean;
  profile_status: string | null;
  deletion_requested_at: string | null;
  restore_allowed: boolean;
  deny_reason: string | null;
};

function classifyVendorRestoreOutcome(status: VendorRestoreStatus): string {
  if (!status.found || status.deny_reason === "not_found") return "not_found";
  if (status.deny_reason === "banned" || status.is_banned) return "denied_banned";
  if (status.deny_reason === "deleted" || status.deletion_requested_at) {
    return "denied_deleted";
  }
  if (!status.restore_allowed) return "denied_banned";
  if (!status.discoverable) return "success_vendor_hidden";
  if (status.profile_status && status.profile_status !== "complete") {
    return "success_vendor_incomplete";
  }
  if (!status.is_active) return "success_vendor_offline";
  return "success_vendor";
}

function logRestoreOutcome(outcome: string) {
  try {
    void supabase.rpc("log_firstopen_restore", {
      p_outcome: outcome,
      p_device_id: getDeviceId(),
    });
  } catch (err) {
    console.warn("[firstOpen] log_firstopen_restore skipped", err);
  }
}

function restoreDebugStamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

export function FirstOpenFlow({ onComplete, onVendorRegister }: Props) {
  const { s } = useLanguage();
  const [stack, setStack] = useState<FlowStep[]>(["chooser"]);
  const step = stack[stack.length - 1] ?? "chooser";

  const [phoneValue, setPhoneValue] = useState("");
  const [otpPhone, setOtpPhone] = useState("");
  const [registerIntent, setRegisterIntent] = useState<RegisterIntent>("customer");
  const [otpPurpose, setOtpPurpose] = useState<OtpPurpose>("restore");
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [notifLoading, setNotifLoading] = useState(false);
  const [inlineMessage, setInlineMessage] = useState<string | null>(null);
  const [inlineTone, setInlineTone] = useState<"success" | "error" | "muted" | "warning">(
    "muted",
  );
  const [awaitingNoAccountContinue, setAwaitingNoAccountContinue] = useState(false);
  const [restoreDebugLines, setRestoreDebugLines] = useState<RestoreDebugLine[]>([]);
  const [restoreDebugElapsedMs, setRestoreDebugElapsedMs] = useState(0);
  const restoreDebugT0Ref = useRef(0);

  const pushRestoreDebug = useCallback((msg: string) => {
    const line = { t: restoreDebugStamp(), msg };
    console.log(`[restore-debug ${line.t}] ${msg}`);
    if (!RESTORE_DEBUG) return;
    setRestoreDebugLines((prev) => [...prev.slice(-40), line]);
  }, []);

  useEffect(() => {
    if (!RESTORE_DEBUG || !restoreLoading) return;
    const id = window.setInterval(() => {
      setRestoreDebugElapsedMs(Date.now() - restoreDebugT0Ref.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [restoreLoading]);

  const pushStep = useCallback((next: FlowStep) => {
    setStack((prev) => [...prev, next]);
  }, []);

  const resetTransient = useCallback(() => {
    setInlineMessage(null);
    setAwaitingNoAccountContinue(false);
  }, []);

  const popStep = useCallback(() => {
    resetTransient();
    setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }, [resetTransient]);

  const goToNotificationStep = useCallback(() => {
    if (Capacitor.isNativePlatform()) {
      pushStep("notification_permission");
    } else {
      setStack(["done"]);
    }
  }, [pushStep]);

  useEffect(() => {
    if (step !== "done") return;
    onComplete();
  }, [step, onComplete]);

  useEffect(() => {
    setFirstOpenBackHandler(() => {
      if (step === "done") return true;
      if (stack.length > 1) {
        popStep();
        return true;
      }
      return false;
    });
    return () => setFirstOpenBackHandler(null);
  }, [step, stack.length, popStep]);

  const beginOtpVerification = useCallback(
    (digits: string, purpose: OtpPurpose) => {
      setOtpPhone(digits);
      setOtpPurpose(purpose);
      pushStep("otp_pending");
    },
    [pushStep],
  );

  const finishAfterOtpVerified = useCallback(
    async (digits: string) => {
      if (
        otpPurpose === "register_customer" ||
        otpPurpose === "restore_new_phone" ||
        otpPurpose === "register_vendor"
      ) {
        saveUserPhone(digits);
        await migrateUserPhone(digits, getDeviceId());
      }
      if (otpPurpose === "register_vendor") {
        onVendorRegister?.();
        setStack(["done"]);
        return;
      }
      goToNotificationStep();
    },
    [goToNotificationStep, onVendorRegister, otpPurpose],
  );

  const handleRegisterPhoneContinue = () => {
    const digits = normalizePhoneDigits(phoneValue);
    if (!digits || !isValidIndianMobile(digits)) {
      setInlineMessage(s.vendor_phone_invalid_body);
      setInlineTone("error");
      return;
    }
    setInlineMessage(null);
    if (!OTP_ENABLED) {
      if (registerIntent === "vendor") {
        onVendorRegister?.();
        setStack(["done"]);
      } else {
        goToNotificationStep();
      }
      return;
    }
    beginOtpVerification(
      digits,
      registerIntent === "vendor" ? "register_vendor" : "register_customer",
    );
  };

  const handleChooseVerifyOtp = () => {
    const digits = normalizePhoneDigits(phoneValue);
    if (!digits) return;
    pushRestoreDebug(`restore chose verify OTP phone=…${digits.slice(-4)}`);
    beginOtpVerification(digits, "restore");
  };

  const handleSkipVerify = () => {
    pushRestoreDebug("restore chose skip verify (no SMS)");
    console.warn(
      "[Phase D] OTP skipped on restore path — no Supabase session established",
    );
    goToNotificationStep();
  };

  const handleNoAccountContinue = () => {
    const digits = normalizePhoneDigits(phoneValue);
    if (!digits) return;
    pushRestoreDebug(`Continue after no-account phone=…${digits.slice(-4)}`);
    setAwaitingNoAccountContinue(false);
    setInlineMessage(null);
    if (!OTP_ENABLED) {
      goToNotificationStep();
      return;
    }
    beginOtpVerification(digits, "restore_new_phone");
  };

  const handleRestore = async () => {
    const digits = normalizePhoneDigits(phoneValue);
    if (!digits || !isValidIndianMobile(digits)) {
      setInlineMessage(s.vendor_phone_invalid_body);
      setInlineTone("error");
      return;
    }

    restoreDebugT0Ref.current = Date.now();
    setRestoreDebugElapsedMs(0);
    setRestoreDebugLines([]);
    pushRestoreDebug(
      `restore tap host=${window.location.host} phone=…${digits.slice(-4)} OTP=${String(OTP_ENABLED)} online=${String(getNavigatorOnline())}`,
    );

    setRestoreLoading(true);
    setInlineMessage(null);
    setAwaitingNoAccountContinue(false);

    try {
      pushRestoreDebug("lookup start (withTimedRetry 12s×3)");
      const [usersResult, vendorStatusResult] = await withTimedRetry(
        async (signal) => {
          pushRestoreDebug("lookup attempt (rpc pair)");
          const [users, vendorStatus] = await Promise.all([
            applyAbortSignal(
              supabase.rpc("lookup_user_by_phone", { p_phone: digits }),
              signal,
            ),
            applyAbortSignal(
              supabase.rpc("get_vendor_restore_status", { p_phone: digits }),
              signal,
            ),
          ]);
          throwOnSupabaseNetworkError(users);
          throwOnSupabaseNetworkError(vendorStatus);
          return [users, vendorStatus] as const;
        },
        {
          onRetrying: (attempt) => {
            pushRestoreDebug(`lookup retry after attempt ${attempt}`);
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      pushRestoreDebug(
        `lookup end ms=${Date.now() - restoreDebugT0Ref.current} usersErr=${usersResult.error?.message ?? "none"} vendorErr=${vendorStatusResult.error?.message ?? "none"}`,
      );

      if (usersResult.error || vendorStatusResult.error) {
        const rateLimited =
          usersResult.error?.message?.includes("rate_limit") ||
          vendorStatusResult.error?.message?.includes("rate_limit");
        logRestoreOutcome(rateLimited ? "rate_limited" : "error");
        if (!rateLimited) {
          captureError(usersResult.error ?? vendorStatusResult.error, {
            scope: "firstOpen.restore.lookup",
            phoneSuffix: digits.slice(-4),
          });
        }
        setInlineMessage(s.firstopen_restore_error);
        setInlineTone("error");
        setRestoreLoading(false);
        return;
      }

      try {
        const vendorStatus = (vendorStatusResult.data ?? null) as VendorRestoreStatus | null;
        const customerRow = usersResult.data?.[0] ?? null;
        const hasCustomer = customerRow != null;
        const customerBanned = customerRow?.is_banned === true;
        const vendorFound = vendorStatus?.found === true;
        const vendorRestorable = vendorFound && vendorStatus?.restore_allowed === true;
        const hasAccount = hasCustomer || vendorFound;

        if (customerBanned) {
          logRestoreOutcome("denied_banned");
          setInlineMessage(s.customer_account_banned);
          setInlineTone("error");
          setRestoreLoading(false);
          return;
        }

        if (hasAccount) {
          saveUserPhone(digits);
          const migration = await migrateUserPhone(digits, getDeviceId());

          if (vendorRestorable && vendorStatus?.vendor_id) {
            restoreVendorSession(vendorStatus.vendor_id, vendorStatus.is_active === true);
          }

          if (!migration.ok) {
            captureError(new Error("firstopen_migrate_partial"), {
              scope: "firstOpen.restore.migrate",
              savedOk: migration.savedOk,
              requestsOk: migration.requestsOk,
              phoneSuffix: digits.slice(-4),
            });
            setInlineMessage(s.firstopen_restore_partial);
            setInlineTone("warning");
          } else {
            setInlineMessage(s.firstopen_restore_found);
            setInlineTone("success");
          }

          if (vendorRestorable && vendorStatus) {
            logRestoreOutcome(classifyVendorRestoreOutcome(vendorStatus));
          } else if (vendorFound && vendorStatus) {
            logRestoreOutcome(classifyVendorRestoreOutcome(vendorStatus));
          } else {
            logRestoreOutcome("success_customer");
          }

          setRestoreLoading(false);

          if (!OTP_ENABLED) {
            goToNotificationStep();
            return;
          }

          pushStep("restore_verify_choice");
          return;
        }

        logRestoreOutcome("not_found");
        setInlineMessage(s.firstopen_no_account);
        setInlineTone("muted");
        setRestoreLoading(false);
        setAwaitingNoAccountContinue(true);
        return;
      } catch (postLookupErr) {
        captureError(postLookupErr, {
          scope: "firstOpen.restore.postLookup",
          phoneSuffix: digits.slice(-4),
        });
        logRestoreOutcome("error");
        setInlineMessage(s.firstopen_restore_error);
        setInlineTone("error");
        setRestoreLoading(false);
        return;
      }
    } catch (err) {
      dismissNetworkRetryingToast();
      captureError(err, { scope: "firstOpen.restore", phoneSuffix: digits.slice(-4) });
      setRestoreLoading(false);
      setInlineTone("error");
      if (isNetworkTimeout(err) || err instanceof NetworkExhaustedError) {
        setInlineMessage(
          isNetworkTimeout(err) ? s.firstopen_restore_timeout : s.network_failed,
        );
      } else {
        setInlineMessage(s.firstopen_restore_error);
      }
      logRestoreOutcome("error");
    }
  };

  const handleAllowNotifications = async () => {
    if (!Capacitor.isNativePlatform()) {
      setStack(["done"]);
      return;
    }

    setNotifLoading(true);
    try {
      const granted = await requestPushPermissionFromOs();
      const phone = getUserPhone();
      if (granted && phone) {
        await registerUserPushToken(phone, { skipPermissionRequest: true });
      }
    } catch {
      /* proceed regardless */
    } finally {
      setNotifLoading(false);
      setStack(["done"]);
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
        <div className="flex flex-1 flex-col justify-center px-4 py-8 max-w-md mx-auto w-full gap-3">
          <button
            type="button"
            data-testid="firstopen-im-new"
            onClick={() => pushStep("new_options")}
            className="w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform"
          >
            {s.welcome_im_new}
          </button>
          <button
            type="button"
            data-testid="firstopen-returning"
            onClick={() => {
              resetTransient();
              setPhoneValue("");
              pushStep("restore");
            }}
            className="w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.98] transition-transform"
          >
            {s.welcome_returning}
          </button>
        </div>
      )}

      {step === "new_options" && (
        <div className="flex flex-1 flex-col justify-center px-4 py-8 max-w-md mx-auto w-full gap-3">
          <h1 className="font-display text-xl font-bold text-foreground leading-tight mb-2">
            {s.welcome_new_options_title}
          </h1>
          <button
            type="button"
            data-testid="firstopen-vendor-btn"
            onClick={() => {
              setRegisterIntent("vendor");
              setPhoneValue("");
              pushStep("register_phone");
            }}
            className="w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform"
          >
            {s.welcome_register_business}
          </button>
          <button
            type="button"
            data-testid="firstopen-use-as-customer"
            onClick={() => {
              setRegisterIntent("customer");
              setPhoneValue("");
              pushStep("register_phone");
            }}
            className="w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.98] transition-transform"
          >
            {s.welcome_use_as_customer}
          </button>
          <button
            type="button"
            data-testid="firstopen-new-options-back"
            onClick={popStep}
            className="mt-2 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80"
          >
            {s.firstopen_restore_back}
          </button>
        </div>
      )}

      {step === "register_phone" && (
        <div className="flex flex-1 flex-col px-4 py-8 max-w-md mx-auto w-full">
          <h1 className="font-display text-xl font-bold text-foreground leading-tight">
            {s.firstopen_register_phone_title}
          </h1>
          <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
            {s.firstopen_register_phone_body}
          </p>
          <div className="mt-6 flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3">
            <span className="text-sm text-muted-foreground font-medium">+91</span>
            <input
              type="tel"
              inputMode="numeric"
              maxLength={10}
              placeholder="98765 43210"
              data-testid="firstopen-register-phone-input"
              value={phoneValue}
              onChange={(e) => {
                setPhoneValue(e.target.value.replace(/\D/g, "").slice(0, 10));
                setInlineMessage(null);
              }}
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>
          {inlineMessage && (
            <p className="mt-3 text-sm text-destructive">{inlineMessage}</p>
          )}
          <button
            type="button"
            data-testid="firstopen-register-phone-continue"
            onClick={handleRegisterPhoneContinue}
            className="mt-6 w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform"
          >
            {s.phone_entry_continue}
          </button>
          <button
            type="button"
            data-testid="firstopen-register-phone-back"
            onClick={popStep}
            className="mt-4 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80"
          >
            {s.firstopen_restore_back}
          </button>
        </div>
      )}

      {step === "restore" && (
        <div className="flex flex-1 flex-col px-4 py-8 max-w-md mx-auto w-full">
          {inlineMessage === s.firstopen_restore_found ? (
            <p
              data-testid="firstopen-restore-message"
              className="mt-3 text-sm leading-relaxed text-brand font-medium"
            >
              {inlineMessage}
            </p>
          ) : (
            <>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                {s.firstopen_restore_title}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground leading-relaxed">
                {s.firstopen_restore_body}
              </p>

              <div className="mt-6 flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3">
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
                    setAwaitingNoAccountContinue(false);
                  }}
                  disabled={restoreLoading || awaitingNoAccountContinue}
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
                  autoFocus
                />
              </div>

              {inlineMessage && (
                <p
                  data-testid="firstopen-restore-message"
                  className={cn(
                    "mt-3 text-sm leading-relaxed",
                    inlineTone === "success" && "text-brand font-medium",
                    inlineTone === "error" && "text-destructive",
                    inlineTone === "muted" && "text-muted-foreground",
                    inlineTone === "warning" && "text-amber-700 dark:text-amber-400 font-medium",
                  )}
                >
                  {inlineMessage}
                </p>
              )}

              {awaitingNoAccountContinue ? (
                <button
                  type="button"
                  data-testid="firstopen-no-account-continue"
                  onClick={handleNoAccountContinue}
                  className="mt-6 w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform"
                >
                  {s.firstopen_no_account_continue}
                </button>
              ) : (
                <button
                  type="button"
                  data-testid="firstopen-restore-cta"
                  disabled={restoreLoading}
                  onClick={() => void handleRestore()}
                  className="mt-6 w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 flex items-center justify-center gap-2"
                >
                  {restoreLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    s.firstopen_restore_cta
                  )}
                </button>
              )}

              <button
                type="button"
                data-testid="firstopen-restore-back"
                disabled={restoreLoading}
                onClick={popStep}
                className="mt-4 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
              >
                {s.firstopen_restore_back}
              </button>
            </>
          )}
        </div>
      )}

      {step === "restore_verify_choice" && (
        <div className="flex flex-1 flex-col justify-center px-4 py-8 max-w-md mx-auto w-full gap-4">
          <p
            data-testid="firstopen-restore-message"
            className="text-sm leading-relaxed text-brand font-medium text-center"
          >
            {inlineMessage ?? s.firstopen_restore_found}
          </p>
          <p className="text-sm text-muted-foreground text-center leading-relaxed">
            {s.firstopen_otp_subtitle.replace(
              "{phone}",
              normalizePhoneDigits(phoneValue) ?? phoneValue,
            )}
          </p>
          <button
            type="button"
            data-testid="restore-verify-otp-btn"
            onClick={handleChooseVerifyOtp}
            className="w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform"
          >
            {s.firstopen_restore_verify_cta}
          </button>
          <button
            type="button"
            data-testid="restore-skip-verify-btn"
            onClick={handleSkipVerify}
            className="w-full text-center text-sm font-semibold text-muted-foreground underline active:opacity-80"
          >
            {s.firstopen_restore_skip_verify}
          </button>
        </div>
      )}

      {OTP_ENABLED && step === "otp_pending" && (
        <div className="flex flex-1 flex-col justify-center px-4 max-w-md mx-auto w-full">
          <PhoneOtpVerification
            phone={otpPhone}
            onVerified={() => {
              void finishAfterOtpVerified(otpPhone);
            }}
            onRequestFailed={
              otpPurpose === "restore"
                ? () => goToNotificationStep()
                : undefined
            }
          />
        </div>
      )}

      {step === "notification_permission" && (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-8 max-w-md mx-auto w-full text-center">
          <p className="text-5xl mb-6" aria-hidden>
            🔔
          </p>
          <h2 className="font-display text-xl font-bold text-foreground leading-tight">
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
            className="mt-8 w-full rounded-xl bg-primary text-primary-foreground h-12 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 flex items-center justify-center gap-2"
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
            onClick={() => {
              markNotificationSkip();
              setStack(["done"]);
            }}
            className="mt-4 w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
          >
            {s.firstopen_notif_skip}
          </button>
        </div>
      )}
    </div>
  );
}
