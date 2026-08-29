import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  migrateUserPhone,
  restoreVendorSession,
  saveUserPhone,
  getUserPhone,
} from "@/lib/userIdentity";
import { OTP_ENABLED, normalizePhoneDigits, isValidIndianMobile } from "@/lib/phoneOtpEnabled";
import { PhoneOtpVerification } from "@/components/PhoneOtpVerification";
import { recordUserReferral } from "@/lib/referral";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";
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

export type PhoneEntryContext = "order" | "save" | "settings";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfirmed: (phone: string) => void;
  context?: PhoneEntryContext;
  /**
   * When true, mid-flow callers still run the existing-account safety net, but
   * after restore (or "continue without restoring") they proceed into the
   * interrupted order/save path via onConfirmed.
   */
  skipRecovery?: boolean;
};

type VendorRestoreStatus = {
  found: boolean;
  vendor_id: string | null;
  is_banned: boolean;
  is_active: boolean;
  restore_allowed: boolean;
  deny_reason: string | null;
};

type ExistingAccountHit = {
  hasCustomer: boolean;
  hasVendor: boolean;
  vendorId: string | null;
  vendorRestorable: boolean;
  vendorIsActive: boolean;
  totalOrders: number;
};

type SheetStep = "phone" | "existing" | "otp";

type PendingConfirmation = {
  digits: string;
  restoreExisting: boolean;
};

async function lookupExistingAccount(phone: string): Promise<{
  banned: boolean;
  hit: ExistingAccountHit | null;
  error: boolean;
  timedOut: boolean;
}> {
  try {
    const [usersResult, vendorStatusResult] = await withTimedRetry(
      async (signal) => {
        const [users, vendorStatus] = await Promise.all([
          applyAbortSignal(
            supabase.rpc("lookup_user_by_phone", { p_phone: phone }),
            signal,
          ),
          applyAbortSignal(
            supabase.rpc("get_vendor_restore_status", { p_phone: phone }),
            signal,
          ),
        ]);
        throwOnSupabaseNetworkError(users);
        throwOnSupabaseNetworkError(vendorStatus);
        return [users, vendorStatus] as const;
      },
      { shouldRetry: () => getNavigatorOnline() },
    );

    if (usersResult.error || vendorStatusResult.error) {
      captureError(usersResult.error ?? vendorStatusResult.error, {
        scope: "phoneEntry.lookupExistingAccount",
        phoneSuffix: phone.slice(-4),
      });
      return { banned: false, hit: null, error: true, timedOut: false };
    }

    const customerRow = usersResult.data?.[0] ?? null;
    const vendorStatus = (vendorStatusResult.data ?? null) as VendorRestoreStatus | null;
    if (customerRow?.is_banned === true) {
      return { banned: true, hit: null, error: false, timedOut: false };
    }

    const hasCustomer = customerRow != null;
    const hasVendor = vendorStatus?.found === true;
    if (!hasCustomer && !hasVendor) {
      return { banned: false, hit: null, error: false, timedOut: false };
    }

    return {
      banned: false,
      hit: {
        hasCustomer,
        hasVendor,
        vendorId: vendorStatus?.vendor_id ?? null,
        vendorRestorable: Boolean(
          hasVendor && vendorStatus?.restore_allowed === true && vendorStatus?.vendor_id,
        ),
        vendorIsActive: vendorStatus?.is_active === true,
        totalOrders: Number(customerRow?.total_orders ?? 0),
      },
      error: false,
      timedOut: false,
    };
  } catch (err) {
    captureError(err, {
      scope: "phoneEntry.lookupExistingAccount",
      phoneSuffix: phone.slice(-4),
    });
    const timedOut =
      isNetworkTimeout(err) || err instanceof NetworkExhaustedError;
    return { banned: false, hit: null, error: true, timedOut };
  }
}

export function PhoneEntrySheet({
  isOpen,
  onClose,
  onConfirmed,
  context = "order",
  skipRecovery = false,
}: Props) {
  const { s } = useLanguage();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState<SheetStep>("phone");
  const [existingAccount, setExistingAccount] = useState<ExistingAccountHit | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setValue("");
    setError("");
    setExistingAccount(null);
    setIsChecking(false);
    setIsRestoring(false);
    setStep("phone");
    setPending(null);
  }, [isOpen]);

  const contextLine =
    context === "save"
      ? s.phone_entry_save_context
      : context === "settings"
        ? s.phone_entry_settings_context
        : s.phone_entry_order_context;

  const finalizePhone = async (normalized: string, restoreExisting: boolean) => {
    saveUserPhone(normalized);
    if (restoreExisting && existingAccount) {
      await migrateUserPhone(normalized, getDeviceId());
      if (existingAccount.vendorRestorable && existingAccount.vendorId) {
        restoreVendorSession(existingAccount.vendorId, existingAccount.vendorIsActive);
      }
    }
    void recordUserReferral(normalized, getDeviceId());
    onConfirmed(normalized);
  };

  const beginOtpStep = (digits: string, restoreExisting: boolean) => {
    setPending({ digits, restoreExisting });
    setStep("otp");
  };

  const completePhoneFlow = (normalized: string, restoreExisting = false) => {
    if (OTP_ENABLED) {
      beginOtpStep(normalized, restoreExisting);
      return;
    }
    void finalizePhone(normalized, restoreExisting);
  };

  const handleConfirm = async () => {
    const digits = normalizePhoneDigits(value);
    if (!isValidIndianMobile(digits)) {
      setError(s.phone_entry_invalid);
      return;
    }

    setIsChecking(true);
    setError("");
    try {
      if (digits === getUserPhone()?.trim()) {
        onConfirmed(digits);
        return;
      }
      showNetworkRetryingToast({ retrying: s.network_retrying });
      const {
        banned,
        hit,
        error: lookupFailed,
        timedOut,
      } = await lookupExistingAccount(digits);
      dismissNetworkRetryingToast();
      if (banned) {
        setError(s.customer_account_banned);
        return;
      }
      if (hit) {
        setExistingAccount(hit);
        setStep("existing");
        return;
      }
      if (lookupFailed) {
        if (timedOut) {
          setError(s.network_timeout);
          return;
        }
        completePhoneFlow(digits);
        return;
      }
      completePhoneFlow(digits);
    } catch (err) {
      dismissNetworkRetryingToast();
      captureError(err, {
        scope: "phoneEntry.handleConfirm",
        phoneSuffix: digits.slice(-4),
      });
      if (isNetworkTimeout(err) || err instanceof NetworkExhaustedError) {
        setError(isNetworkTimeout(err) ? s.network_timeout : s.network_failed);
        return;
      }
      completePhoneFlow(digits);
    } finally {
      setIsChecking(false);
    }
  };

  const handleRestoreExisting = async () => {
    const digits = normalizePhoneDigits(value);
    if (!existingAccount || !isValidIndianMobile(digits)) return;
    setIsRestoring(true);
    try {
      completePhoneFlow(digits, true);
      setExistingAccount(null);
    } catch (err) {
      captureError(err, {
        scope: "phoneEntry.restoreExisting",
        phoneSuffix: digits.slice(-4),
      });
      completePhoneFlow(digits, false);
      setExistingAccount(null);
    } finally {
      setIsRestoring(false);
    }
  };

  const handleContinueWithoutRestore = () => {
    const digits = normalizePhoneDigits(value);
    completePhoneFlow(digits, false);
    setExistingAccount(null);
  };

  const handleSheetOpenChange = (open: boolean) => {
    if (!open) {
      setExistingAccount(null);
      setIsChecking(false);
      setIsRestoring(false);
      setStep("phone");
      setPending(null);
      onClose();
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleSheetOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl"
      >
        {step === "otp" && pending ? (
          <PhoneOtpVerification
            phone={pending.digits}
            className="py-4"
            onVerified={() => {
              void finalizePhone(pending.digits, pending.restoreExisting).then(() => {
                setPending(null);
                setStep("phone");
              });
            }}
          />
        ) : existingAccount && step === "existing" ? (
          <>
            <SheetHeader className="text-left space-y-1 pr-8">
              <SheetTitle className="font-display text-lg" data-testid="phone-entry-existing-title">
                {s.firstopen_existing_title}
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                {existingAccount.totalOrders > 0
                  ? s.recovery_welcome_body.replace(
                      "{count}",
                      String(existingAccount.totalOrders),
                    )
                  : s.firstopen_existing_body}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-3">
              <button
                type="button"
                data-testid="phone-entry-existing-restore"
                disabled={isRestoring}
                onClick={() => void handleRestoreExisting()}
                className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 flex items-center justify-center gap-2"
              >
                {isRestoring ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  s.firstopen_existing_restore
                )}
              </button>
              <button
                type="button"
                data-testid="phone-entry-existing-continue"
                disabled={isRestoring}
                onClick={handleContinueWithoutRestore}
                className="w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
              >
                {skipRecovery
                  ? s.firstopen_existing_continue
                  : s.phone_entry_continue}
              </button>
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="text-left space-y-1 pr-8">
              <SheetTitle className="font-display text-lg">
                {s.phone_entry_title}
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                {s.phone_entry_subtitle}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-3">
              <p className="text-sm text-foreground leading-relaxed px-1">{contextLine}</p>

              <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-4 py-3">
                <span className="text-sm text-muted-foreground font-medium">+91</span>
                <input
                  type="tel"
                  inputMode="numeric"
                  maxLength={10}
                  placeholder={s.phone_entry_placeholder}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value.replace(/\D/g, "").slice(0, 10));
                    setError("");
                  }}
                  className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/50"
                  autoFocus
                  disabled={isChecking}
                />
              </div>

              {error && (
                <p className="text-xs text-destructive px-1">{error}</p>
              )}

              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={isChecking}
                className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform disabled:opacity-70 disabled:active:scale-100 flex items-center justify-center gap-2"
              >
                {isChecking ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    {s.phone_entry_checking}
                  </>
                ) : (
                  s.phone_entry_continue
                )}
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={isChecking}
                className="w-full text-center text-sm font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
              >
                {s.cancel}
              </button>

              <p className="text-xs text-muted-foreground text-center px-2 leading-relaxed">
                {s.phone_entry_privacy}
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
