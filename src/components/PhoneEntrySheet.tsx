import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { saveUserPhone } from "@/lib/userIdentity";
import { recordUserReferral } from "@/lib/referral";
import { getDeviceId } from "@/lib/deviceId";
import { useLanguage } from "@/lib/language";
import { supabase } from "@/lib/supabase";

export type PhoneEntryContext = "order" | "save";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfirmed: (phone: string) => void;
  context?: PhoneEntryContext;
  /**
   * Bypass the "Welcome back!" account-recovery screen (BR-3) and call
   * onConfirmed directly after saving the phone. Set when the user is already
   * mid-flow (ordering, booking, saving a vendor) — the recovery screen there
   * blocks completion. Recovery should only show on first app open.
   */
  skipRecovery?: boolean;
};

async function checkExistingAccount(
  phone: string,
): Promise<{ total_orders: number; completed_orders: number } | null> {
  const { data, error } = await supabase
    .from("users")
    .select("total_orders, completed_orders")
    .eq("phone", phone)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return {
    total_orders: data.total_orders ?? 0,
    completed_orders: data.completed_orders ?? 0,
  };
}

function normalizePhoneDigits(raw: string): string {
  const cleaned = raw.replace(/\D/g, "");
  return cleaned.length === 12 && cleaned.startsWith("91")
    ? cleaned.slice(2)
    : cleaned;
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
  const [existingAccount, setExistingAccount] = useState<{
    total_orders: number;
    completed_orders: number;
  } | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  const contextLine =
    context === "save" ? s.phone_entry_save_context : s.phone_entry_order_context;

  const completePhoneFlow = (normalized: string) => {
    saveUserPhone(normalized);
    onConfirmed(normalized);
    void recordUserReferral(normalized, getDeviceId());
  };

  const handleConfirm = async () => {
    const digits = normalizePhoneDigits(value);
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
      setError("Please enter a valid 10-digit Indian mobile number.");
      return;
    }

    if (skipRecovery) {
      completePhoneFlow(digits);
      return;
    }

    setIsChecking(true);
    const result = await checkExistingAccount(digits);
    setIsChecking(false);

    if (result && result.total_orders > 0) {
      setExistingAccount(result);
      return;
    }

    completePhoneFlow(digits);
  };

  const handleRecoveryContinue = () => {
    const digits = normalizePhoneDigits(value);
    completePhoneFlow(digits);
    setExistingAccount(null);
  };

  const handleSheetOpenChange = (open: boolean) => {
    if (!open) {
      setExistingAccount(null);
      setIsChecking(false);
      onClose();
    }
  };

  return (
    <Sheet open={isOpen} onOpenChange={handleSheetOpenChange}>
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl"
      >
        {existingAccount ? (
          <>
            <SheetHeader className="text-left space-y-1 pr-8">
              <SheetTitle className="font-display text-lg">
                {s.recovery_welcome_title}
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                {s.recovery_welcome_body.replace(
                  "{count}",
                  String(existingAccount.total_orders),
                )}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-5 space-y-3">
              <button
                type="button"
                onClick={handleRecoveryContinue}
                className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform"
              >
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <SheetHeader className="text-left space-y-1 pr-8">
              <SheetTitle className="font-display text-lg">
                Enter your mobile number
              </SheetTitle>
              <SheetDescription className="text-sm text-muted-foreground">
                So the vendor can reach you and your orders are saved across devices.
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
                  placeholder="98765 43210"
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
                    Checking...
                  </>
                ) : (
                  "Continue"
                )}
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={isChecking}
                className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground disabled:opacity-70"
              >
                Cancel
              </button>

              <p className="text-center text-[11px] text-muted-foreground/70 pb-1">
                Your number is only used to save your orders. We never share it.
              </p>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
