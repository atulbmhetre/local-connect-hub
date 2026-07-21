import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase, invokeNotifyVendor } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { strings, type Language } from "@/lib/strings";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import { isValidPaymentUtr } from "@/lib/validation";

export interface UpiPaymentPanelProps {
  /** Prefix for DOM ids (kept distinct per surface for tests/labels). */
  idPrefix: string;
  orderId: string;
  paymentStatus: string;
  amountRupees: number;
  vendorId: string;
  shopName: string;
  upiId: string;
  vendorPhone: string;
  qrUrl: string | null | undefined;
  qrPayeeId: string | null | undefined;
  /** Optional block rendered above the tabs while the order is still unpaid. */
  header?: ReactNode;
}

type PaymentTab = "upi" | "mobile" | "qr";

/**
 * Single UPI pay + return-confirmation flow shared by PaymentSheet and
 * ParchiSheet. Uses the resume-based "Did you pay?" prompt (app/tab regains
 * focus after the UPI deep link) — the newer design from Session 63 — rather
 * than the older client-side countdown timer.
 */
export function UpiPaymentPanel({
  idPrefix,
  orderId,
  paymentStatus,
  amountRupees,
  vendorId,
  shopName,
  upiId,
  vendorPhone,
  qrUrl,
  qrPayeeId,
  header,
}: UpiPaymentPanelProps) {
  const { s } = useLanguage();
  const [activeTab, setActiveTab] = useState<PaymentTab>("upi");
  const [payTapped, setPayTapped] = useState(false);
  const [userConfirmedPaid, setUserConfirmedPaid] = useState(false);
  const [showReturnPrompt, setShowReturnPrompt] = useState(false);
  const [utr, setUtr] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [localPaymentStatus, setLocalPaymentStatus] = useState(paymentStatus);

  const payTappedRef = useRef(payTapped);
  const userConfirmedPaidRef = useRef(userConfirmedPaid);
  useEffect(() => {
    payTappedRef.current = payTapped;
  }, [payTapped]);
  useEffect(() => {
    userConfirmedPaidRef.current = userConfirmedPaid;
  }, [userConfirmedPaid]);

  const amountLabel = amountRupees.toFixed(2);
  const vendorQrUrl = qrUrl?.trim() || "";
  const vendorQrPayeeId = qrPayeeId?.trim() || "";

  useEffect(() => {
    setLocalPaymentStatus(paymentStatus);
    setActiveTab("upi");
    setPayTapped(false);
    setUserConfirmedPaid(false);
    setShowReturnPrompt(false);
    setUtr("");
    setSubmitting(false);
  }, [orderId, paymentStatus]);

  useEffect(() => {
    const onResume = () => {
      if (!payTappedRef.current || userConfirmedPaidRef.current) return;
      setShowReturnPrompt(true);
    };

    if (Capacitor.isNativePlatform()) {
      let removeListener: (() => void) | undefined;
      void App.addListener("appStateChange", ({ isActive }) => {
        if (isActive) onResume();
      }).then((handle) => {
        removeListener = () => void handle.remove();
      });
      return () => {
        removeListener?.();
      };
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onResume();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const selectTab = (tab: PaymentTab) => {
    setActiveTab(tab);
    setPayTapped(false);
    setUserConfirmedPaid(false);
    setShowReturnPrompt(false);
    setUtr("");
  };

  const openDeepLink = (pa: string) => {
    const deepLink = `upi://pay?pa=${pa}&pn=${encodeURIComponent(shopName)}&am=${amountRupees}&tn=AaspaasOrder-${orderId}`;
    window.open(deepLink, "_blank");
    setPayTapped(true);
    setUserConfirmedPaid(false);
    setShowReturnPrompt(false);
  };

  const handlePayNowUpi = () => {
    if (!upiId) return;
    openDeepLink(upiId);
  };

  const handlePayNowMobile = () => {
    if (!vendorPhone) return;
    openDeepLink(`${vendorPhone}@upi`);
  };

  const handlePayNowQr = () => {
    if (!vendorQrPayeeId) return;
    openDeepLink(vendorQrPayeeId);
  };

  const handleSubmitUtr = useCallback(async () => {
    const trimmed = utr.trim();
    if (!isValidPaymentUtr(trimmed)) {
      toast.error(s.payment_utr_invalid);
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("claim_customer_payment", {
      p_request_id: orderId,
      p_payment_utr: trimmed,
      p_device_id: getDeviceId(),
      p_user_phone: getUserPhone(),
    });
    if (error) {
      captureError(error, { scope: "upiPaymentPanel.claimCustomerPayment", orderId });
      toast.error(s.payment_confirm_error);
      setSubmitting(false);
      return;
    }
    // The vendor is the recipient, so the notification copy resolves from the
    // VENDOR's own language preference (resolve_user_lang, same pattern as the
    // referral-credit notification) — not the paying customer's device language.
    void (async () => {
      let vendorLang: Language = "en";
      const { data: langData, error: langError } = await supabase.rpc("resolve_user_lang", {
        p_user_phone: vendorPhone,
      });
      if (langError) {
        captureError(langError, { scope: "upiPaymentPanel.resolveVendorLang", orderId });
      } else if (langData === "hi" || langData === "mr") {
        vendorLang = langData;
      }
      const vendorStrings = strings[vendorLang];
      void invokeNotifyVendor({
        vendor_id: vendorId,
        notification_title: vendorStrings.notifyVendor_paymentClaimed_title,
        message: vendorStrings.notifyVendor_paymentClaimed_body(amountLabel, trimmed),
        type: "payment_claimed",
        request_id: orderId,
      });
    })();
    setLocalPaymentStatus("claimed");
    setSubmitting(false);
  }, [amountLabel, orderId, s.payment_confirm_error, s.payment_utr_invalid, utr, vendorId, vendorPhone]);

  const tabs: { id: PaymentTab; label: string }[] = [
    { id: "upi", label: s.payment_tab_upi },
    { id: "mobile", label: s.payment_tab_mobile },
    { id: "qr", label: s.payment_tab_qr },
  ];

  const showUtrInput =
    activeTab === "qr"
      ? vendorQrPayeeId
        ? userConfirmedPaid
        : !!vendorQrUrl
      : userConfirmedPaid;

  const returnPromptBlock = showReturnPrompt ? (
    <div className="space-y-2 rounded-xl border border-surface-border bg-surface px-3 py-3">
      <p className="text-sm text-foreground text-center font-medium">{s.payment_didYouPay}</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setShowReturnPrompt(false);
            setUserConfirmedPaid(true);
          }}
          className="rounded-xl bg-brand text-white text-sm font-semibold py-2.5 active:scale-[0.98]"
        >
          {s.payment_yesPaid}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowReturnPrompt(false);
            setPayTapped(false);
            setUserConfirmedPaid(false);
            setUtr("");
          }}
          className="rounded-xl border border-surface-border text-sm font-semibold py-2.5 active:scale-[0.98]"
        >
          {s.payment_noPaid}
        </button>
      </div>
    </div>
  ) : null;

  if (localPaymentStatus === "claimed") {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-foreground">
        <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />
        {s.payment_claimed}
      </div>
    );
  }

  if (localPaymentStatus === "confirmed") {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-foreground">
        <span className="h-2 w-2 shrink-0 rounded-full bg-green-500" aria-hidden />
        {s.payment_confirmed}
      </div>
    );
  }

  if (localPaymentStatus === "disputed") {
    return (
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
            setPayTapped(false);
            setUserConfirmedPaid(false);
            setShowReturnPrompt(false);
          }}
          className="w-full min-h-11 rounded-2xl border border-surface-border text-sm font-semibold text-foreground py-3 active:scale-[0.98] transition-transform"
        >
          {s.payment_resubmit_utr}
        </button>
      </div>
    );
  }

  if (localPaymentStatus !== "unpaid") return null;

  return (
    <div className="space-y-4">
      {header}
      <div className="flex border-b border-surface-border">
        {tabs.map((tab) => (
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
          {returnPromptBlock}
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
          {returnPromptBlock}
        </div>
      )}

      {activeTab === "qr" && (
        <div className="space-y-3 text-center">
          {!vendorQrUrl && !vendorQrPayeeId ? (
            <p className="text-xs text-muted-foreground">{s.payment_qr_missing}</p>
          ) : vendorQrPayeeId ? (
            <div className="space-y-3">
              {!payTapped && (
                <button
                  type="button"
                  onClick={handlePayNowQr}
                  className="w-full min-h-11 bg-brand text-white font-bold py-3 rounded-2xl text-sm active:scale-[0.98] transition-transform"
                >
                  {s.payment_pay_now}
                </button>
              )}
              {returnPromptBlock}
            </div>
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
            htmlFor={`${idPrefix}-utr`}
            className="text-xs font-medium text-muted-foreground uppercase tracking-wide block"
          >
            {s.payment_enter_utr}
          </label>
          <input
            id={`${idPrefix}-utr`}
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
  );
}
