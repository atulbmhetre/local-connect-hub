import { useState } from "react";
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

export type PhoneEntryContext = "order" | "save";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onConfirmed: (phone: string) => void;
  context?: PhoneEntryContext;
};

export function PhoneEntrySheet({
  isOpen,
  onClose,
  onConfirmed,
  context = "order",
}: Props) {
  const { s } = useLanguage();
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const contextLine =
    context === "save" ? s.phone_entry_save_context : s.phone_entry_order_context;

  const handleConfirm = () => {
    const cleaned = value.replace(/\D/g, "");
    const digits =
      cleaned.length === 12 && cleaned.startsWith("91")
        ? cleaned.slice(2)
        : cleaned;
    if (digits.length !== 10 || !/^[6-9]/.test(digits)) {
      setError("Please enter a valid 10-digit Indian mobile number.");
      return;
    }
    const { normalized } = saveUserPhone(digits);
    onConfirmed(normalized);
    void recordUserReferral(normalized, getDeviceId());
  };

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="bottom"
        className="bg-card border-t border-border rounded-t-2xl"
      >
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
            />
          </div>

          {error && (
            <p className="text-xs text-destructive px-1">{error}</p>
          )}

          <button
            type="button"
            onClick={handleConfirm}
            className="w-full rounded-xl bg-primary text-primary-foreground py-3.5 font-semibold active:scale-[0.98] transition-transform"
          >
            Continue
          </button>

          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl border border-border py-3 text-sm font-semibold text-muted-foreground"
          >
            Cancel
          </button>

          <p className="text-center text-[11px] text-muted-foreground/70 pb-1">
            Your number is only used to save your orders. We never share it.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
