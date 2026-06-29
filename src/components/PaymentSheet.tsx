import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { supabase, invokeNotifyVendor } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";

export interface PaymentSheetProps {
  open: boolean;
  onClose: () => void;
  order: {
    id: string;
    status: string;
    payment_status: string;
    amountRupees: number;
  };
  vendor: {
    vendor_id: string;
    shop_name: string;
    upi_id: string;
    phone: string;
    upi_qr_url: string | null;
  };
}

type PaymentTab = "upi" | "mobile" | "qr";

const TABS: { id: PaymentTab; label: string }[] = [
  { id: "upi", label: "UPI ID" },
  { id: "mobile", label: "Mobile" },
  { id: "qr", label: "QR Code" },
];

export function PaymentSheet({ open, onClose, order, vendor }: PaymentSheetProps) {
  const { s } = useLanguage();
  const [activeTab, setActiveTab] = useState<PaymentTab>("upi");
  const [timer, setTimer] = useState(30);
  const [timerActive, setTimerActive] = useState(false);
  const [payTapped, setPayTapped] = useState(false);
  const [utr, setUtr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localPaymentStatus, setLocalPaymentStatus] = useState(order.payment_status);

  const amountLabel = order.amountRupees.toFixed(2);
  const vendorQrUrl = vendor.upi_qr_url?.trim() || "";

  useEffect(() => {
    setLocalPaymentStatus(order.payment_status);
  }, [order.id, order.payment_status]);

  useEffect(() => {
    if (!open) {
      setActiveTab("upi");
      setTimer(30);
      setTimerActive(false);
      setPayTapped(false);
      setUtr("");
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    if (!timerActive) return;
    const id = window.setInterval(() => {
      setTimer((t) => {
        if (t <= 1) {
          setTimerActive(false);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [timerActive]);

  const selectTab = (tab: PaymentTab) => {
    setActiveTab(tab);
    setTimer(30);
    setTimerActive(false);
    setPayTapped(false);
    setUtr("");
  };

  const openDeepLink = (pa: string) => {
    const deepLink = `upi://pay?pa=${pa}&pn=${encodeURIComponent(vendor.shop_name)}&am=${order.amountRupees}&tn=AaspaasOrder-${order.id}`;
    window.open(deepLink, "_blank");
    setPayTapped(true);
    setTimer(30);
    setTimerActive(true);
  };

  const handlePayNowUpi = () => {
    if (!vendor.upi_id) return;
    openDeepLink(vendor.upi_id);
  };

  const handlePayNowMobile = () => {
    if (!vendor.phone) return;
    openDeepLink(`${vendor.phone}@upi`);
  };

  const handleSubmitUtr = useCallback(async () => {
    const trimmed = utr.trim();
    if (!/^\d{12}$/.test(trimmed)) {
      toast.error(s.payment_utr_invalid);
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("claim_customer_payment", {
      p_request_id: order.id,
      p_payment_utr: trimmed,
      p_device_id: getDeviceId(),
      p_user_phone: getUserPhone(),
    });
    if (error) {
      toast.error(s.payment_confirm_error);
      setSubmitting(false);
      return;
    }
    void invokeNotifyVendor({
      vendor_id: vendor.vendor_id,
      notification_title: s.payment_pay_now,
      message: `Customer claims payment of ₹${amountLabel} — UTR: ${trimmed}`,
      type: "payment_claimed",
      request_id: order.id,
    });
    setLocalPaymentStatus("claimed");
    setSubmitting(false);
  }, [amountLabel, order.id, s.payment_confirm_error, s.payment_pay_now, s.payment_utr_invalid, utr, vendor.vendor_id]);

  const showUtrInput =
    activeTab === "qr"
      ? !!vendorQrUrl
      : payTapped && !timerActive && timer === 0;

  const handleOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        data-testid="payment-sheet"
        side="bottom"
        className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[90vh] flex flex-col [&>button]:text-muted-foreground"
        style={{
          transform: "translateZ(0)",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{s.payment_pay_now}</SheetTitle>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          {localPaymentStatus === "unpaid" ? (
            <div className="space-y-4 pt-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{s.payment_pay_now}</p>
                <p className="text-sm text-muted-foreground mt-0.5">{vendor.shop_name}</p>
                <p className="text-xl font-bold text-foreground mt-2">₹{amountLabel}</p>
              </div>

              <div className="flex border-b border-surface-border">
                {TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => selectTab(tab.id)}
                    className={cn(
                      "flex-1 pb-2 text-xs font-semibold transition-colors border-b-2 -mb-px",
                      activeTab === tab.id
                        ? "border-foreground text-foreground"
                        : "border-transparent text-muted-foreground",
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeTab === "upi" && (
                <div className="space-y-3">
                  {!payTapped && (
                    <button
                      type="button"
                      onClick={handlePayNowUpi}
                      className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform"
                    >
                      {s.payment_pay_now}
                    </button>
                  )}
                  {timerActive && timer > 0 && (
                    <p className="text-sm text-muted-foreground text-center">
                      {s.payment_timer.replace("{n}", String(timer))}
                    </p>
                  )}
                </div>
              )}

              {activeTab === "mobile" && (
                <div className="space-y-3">
                  {!payTapped && (
                    <button
                      type="button"
                      onClick={handlePayNowMobile}
                      className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform"
                    >
                      {s.payment_pay_now}
                    </button>
                  )}
                  {timerActive && timer > 0 && (
                    <p className="text-sm text-muted-foreground text-center">
                      {s.payment_timer.replace("{n}", String(timer))}
                    </p>
                  )}
                </div>
              )}

              {activeTab === "qr" && (
                <div className="space-y-3 text-center">
                  {!vendorQrUrl ? (
                    <p className="text-xs text-muted-foreground">
                      Vendor hasn&apos;t uploaded a QR code yet
                    </p>
                  ) : (
                    <>
                      <img
                        src={vendorQrUrl}
                        alt=""
                        className="mx-auto h-[200px] w-[200px] rounded-lg border border-surface-border object-contain"
                      />
                      <p className="text-sm text-foreground">
                        <span className="font-bold">₹{amountLabel}</span>{" "}
                        {s.payment_amount_label}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.payment_scan_instruction}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.payment_enter_amount.replace("{amount}", amountLabel)}
                      </p>
                    </>
                  )}
                </div>
              )}

              {showUtrInput && (
                <div className="space-y-2">
                  <label
                    htmlFor="payment-sheet-utr"
                    className="text-xs font-medium text-muted-foreground uppercase tracking-wide block"
                  >
                    {s.payment_enter_utr}
                  </label>
                  <input
                    id="payment-sheet-utr"
                    type="text"
                    inputMode="numeric"
                    maxLength={12}
                    value={utr}
                    onChange={(e) => setUtr(e.target.value.replace(/\D/g, "").slice(0, 12))}
                    className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-brand/50"
                  />
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void handleSubmitUtr()}
                    className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform disabled:opacity-60"
                  >
                    {submitting ? (
                      <Loader2 className="h-4 w-4 animate-spin mx-auto" />
                    ) : (
                      s.payment_submit_utr
                    )}
                  </button>
                </div>
              )}
            </div>
          ) : localPaymentStatus === "claimed" ? (
            <div className="flex items-center gap-2 py-4 text-sm text-foreground">
              <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />
              {s.payment_claimed}
            </div>
          ) : localPaymentStatus === "confirmed" ? (
            <div className="flex items-center gap-2 py-4 text-sm text-foreground">
              <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
              {s.payment_confirmed}
            </div>
          ) : localPaymentStatus === "disputed" ? (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
                {s.payment_disputed}
              </div>
              <p className="text-xs text-muted-foreground">{s.payment_disputed_message}</p>
              <button
                type="button"
                onClick={() => {
                  setLocalPaymentStatus("unpaid");
                  setUtr("");
                  setTimer(30);
                  setTimerActive(false);
                }}
                className="w-full min-h-11 rounded-2xl border border-surface-border text-sm font-semibold text-foreground py-3 active:scale-[0.98] transition-transform"
              >
                {s.payment_resubmit_utr}
              </button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
