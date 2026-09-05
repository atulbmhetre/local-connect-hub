import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { getDeviceId } from "@/lib/deviceId";
import { getUserPhone } from "@/lib/userIdentity";
import { useLanguage } from "@/lib/language";
import { captureError } from "@/lib/sentry";
import { cn } from "@/lib/utils";
import { isValidPaymentUtr } from "@/lib/validation";
import { MIN_PAYMENT_AWAY_MS } from "@/lib/paymentResume";
import { uploadPaymentProof } from "@/lib/paymentProofUpload";
import {
  paymentDestinationsChanged,
  paymentQrUrlChanged,
  type BilledPaymentDestination,
} from "@/lib/paymentDestinationChanged";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  NetworkExhaustedError,
  applyAbortSignal,
  throwOnSupabaseNetworkError,
  withTimedRetry,
} from "@/lib/withNetworkRetry";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";

/** Per-attempt budget for claim RPC — hung TCP must surface as retry/failure. */
const CLAIM_PAYMENT_TIMEOUT_MS = 15_000;
const SCREENSHOT_UPLOAD_TIMEOUT_MS = 15_000;

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

type ClaimRequirements = {
  requires_screenshot: boolean;
  is_anomalous: boolean;
};

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
  vendorId: _vendorId,
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
  /** Sync guard — disabled={submitting} alone loses a fast double-tap before re-render. */
  const submittingLockRef = useRef(false);
  const screenshotLockRef = useRef(false);
  const [localPaymentStatus, setLocalPaymentStatus] = useState(paymentStatus);
  const [requiresScreenshot, setRequiresScreenshot] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotUploading, setScreenshotUploading] = useState(false);
  const [billedDestination, setBilledDestination] =
    useState<BilledPaymentDestination | null>(null);

  const payTappedRef = useRef(payTapped);
  const userConfirmedPaidRef = useRef(userConfirmedPaid);
  const payTappedAtRef = useRef<number | null>(null);

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
    setScreenshotUrl(null);
    setScreenshotUploading(false);
    setBilledDestination(null);
    payTappedAtRef.current = null;
  }, [orderId, paymentStatus]);

  useEffect(() => {
    if (paymentStatus !== "unpaid") {
      setRequiresScreenshot(false);
      return;
    }

    let cancelled = false;
    void supabase
      .rpc("snapshot_intended_upi_payee", {
        p_request_id: orderId,
        p_device_id: getDeviceId(),
        p_user_phone: getUserPhone(),
      })
      .then(({ error: snapErr }) => {
        if (cancelled || !snapErr) return;
        captureError(snapErr, { scope: "upiPaymentPanel.snapshotIntendedUpi", orderId });
      });
    void supabase
      .from("requests")
      .select(
        "billed_upi_id, billed_upi_qr_url, billed_upi_payee_id, billed_payment_phone, billed_payment_snapshot_at",
      )
      .eq("id", orderId)
      .maybeSingle()
      .then(({ data, error: billedErr }) => {
        if (cancelled) return;
        if (billedErr) {
          captureError(billedErr, { scope: "upiPaymentPanel.billedDestination", orderId });
          setBilledDestination(null);
          return;
        }
        setBilledDestination((data as BilledPaymentDestination | null) ?? null);
      });
    void (async () => {
      const { data, error } = await supabase.rpc("get_payment_claim_requirements", {
        p_request_id: orderId,
        p_device_id: getDeviceId(),
        p_user_phone: getUserPhone(),
      });
      if (cancelled) return;
      if (error) {
        captureError(error, { scope: "upiPaymentPanel.claimRequirements", orderId });
        setRequiresScreenshot(false);
        return;
      }
      const row = data as ClaimRequirements | null;
      setRequiresScreenshot(row?.requires_screenshot === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId, paymentStatus]);

  const tryShowReturnPrompt = useCallback(() => {
    if (!payTappedRef.current || userConfirmedPaidRef.current) return;
    const tappedAt = payTappedAtRef.current;
    if (tappedAt == null) return;
    if (Date.now() - tappedAt < MIN_PAYMENT_AWAY_MS) return;
    setShowReturnPrompt(true);
  }, []);

  useEffect(() => {
    const onResume = () => {
      tryShowReturnPrompt();
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
  }, [tryShowReturnPrompt]);

  const selectTab = (tab: PaymentTab) => {
    setActiveTab(tab);
    setPayTapped(false);
    setUserConfirmedPaid(false);
    setShowReturnPrompt(false);
    setUtr("");
    payTappedAtRef.current = null;
  };

  const openDeepLink = (pa: string) => {
    const deepLink = `upi://pay?pa=${pa}&pn=${encodeURIComponent(shopName)}&am=${amountRupees}&tn=AaspaasOrder-${orderId}`;
    window.open(deepLink, "_blank");
    payTappedAtRef.current = Date.now();
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

  const handleScreenshotPick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (screenshotLockRef.current) return;
    screenshotLockRef.current = true;

    setScreenshotUploading(true);
    try {
      const uploaded = await withTimedRetry(
        async (signal) => {
          void signal;
          return uploadPaymentProof(orderId, file);
        },
        {
          timeoutMs: SCREENSHOT_UPLOAD_TIMEOUT_MS,
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      setScreenshotUrl(uploaded.publicUrl);
    } catch (err) {
      dismissNetworkRetryingToast();
      captureError(err, { scope: "upiPaymentPanel.uploadScreenshot", orderId });
      toast.error(s.payment_confirm_error);
    } finally {
      setScreenshotUploading(false);
      screenshotLockRef.current = false;
    }
  };

  const handleSubmitUtr = useCallback(async () => {
    const trimmed = utr.trim();
    if (!isValidPaymentUtr(trimmed)) {
      toast.error(s.payment_utr_invalid);
      return;
    }
    if (requiresScreenshot && !screenshotUrl) {
      toast.error(s.payment_screenshot_required);
      return;
    }
    if (submittingLockRef.current) return;
    submittingLockRef.current = true;

    setSubmitting(true);
    try {
      const { error } = await withTimedRetry(
        async (signal) =>
          throwOnSupabaseNetworkError(
            await applyAbortSignal(
              supabase.rpc("claim_customer_payment", {
                p_request_id: orderId,
                p_payment_utr: trimmed,
                p_device_id: getDeviceId(),
                p_user_phone: getUserPhone(),
                p_payment_screenshot_url: screenshotUrl,
              }),
              signal,
            ),
          ),
        {
          timeoutMs: CLAIM_PAYMENT_TIMEOUT_MS,
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (error) {
        captureError(error, { scope: "upiPaymentPanel.claimCustomerPayment", orderId });
        const errMsg = error.message ?? "";
        if (errMsg.includes("payment_self_declare_restricted")) {
          try {
            const { data: blockData, error: blockErr } = await supabase.rpc(
              "get_customer_payment_block_status",
              {
                p_device_id: getDeviceId(),
                p_user_phone: getUserPhone(),
              },
            );
            if (blockErr) {
              captureError(blockErr, {
                scope: "upiPaymentPanel.paymentBlockStatus",
                orderId,
              });
            } else {
              const blockRow = blockData?.[0] as
                | { is_blocked?: boolean; request_id?: string | null }
                | undefined;
              if (blockRow?.is_blocked && blockRow.request_id === orderId) {
                toast.error(s.payment_restricted_blocking_bill_resolve(shopName));
                return;
              }
            }
          } catch (blockLookupErr) {
            captureError(blockLookupErr, {
              scope: "upiPaymentPanel.paymentBlockStatus",
              orderId,
            });
          }
        }
        toast.error(s.payment_confirm_error);
        return;
      }
      setLocalPaymentStatus("claimed");
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleSubmitUtr(), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        captureError(err, { scope: "upiPaymentPanel.claimCustomerPayment", orderId });
        toast.error(s.payment_confirm_error);
      }
    } finally {
      setSubmitting(false);
      submittingLockRef.current = false;
    }
  }, [
    orderId,
    requiresScreenshot,
    screenshotUrl,
    s.network_failed,
    s.network_retry_btn,
    s.network_retrying,
    s.payment_confirm_error,
    s.payment_restricted_blocking_bill_resolve,
    s.payment_screenshot_required,
    s.payment_utr_invalid,
    utr,
    shopName,
  ]);

  const liveDestination = {
    upiId,
    qrUrl: vendorQrUrl || null,
    qrPayeeId: vendorQrPayeeId || null,
    paymentPhone: vendorPhone,
  };
  const showUpdatedNotice = paymentDestinationsChanged(billedDestination, liveDestination);
  const qrUrlChanged = paymentQrUrlChanged(billedDestination, liveDestination);
  const showStaticQrImage = !!vendorQrUrl && !vendorQrPayeeId;

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
    <div
      className="space-y-2 rounded-xl border border-surface-border bg-surface px-3 py-3"
      data-testid={`${idPrefix}-return-prompt`}
    >
      <p className="text-sm text-foreground text-center font-medium">{s.payment_didYouPay}</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => {
            setShowReturnPrompt(false);
            setUserConfirmedPaid(true);
          }}
          className="rounded-xl bg-brand text-white text-sm font-semibold h-10 active:scale-[0.98]"
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
            payTappedAtRef.current = null;
          }}
          className="rounded-xl border border-surface-border text-sm font-semibold h-10 active:scale-[0.98]"
        >
          {s.payment_noPaid}
        </button>
      </div>
    </div>
  ) : null;

  const screenshotBlock =
    requiresScreenshot && showUtrInput ? (
      <div className="space-y-2" data-testid={`${idPrefix}-screenshot-section`}>
        <p className="text-xs text-muted-foreground leading-snug">{s.payment_screenshot_hint}</p>
        <label
          htmlFor={`${idPrefix}-screenshot`}
          className={cn(
            "flex items-center justify-center gap-2 w-full h-10 rounded-xl border border-dashed border-surface-border text-sm font-semibold  cursor-pointer",
            screenshotUrl && "border-brand/50 text-brand",
          )}
        >
          {screenshotUploading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {s.payment_screenshot_uploading}
            </>
          ) : (
            <>
              <Camera className="h-4 w-4" />
              {screenshotUrl ? s.payment_screenshot_label : s.payment_screenshot_attach}
            </>
          )}
        </label>
        <input
          id={`${idPrefix}-screenshot`}
          type="file"
          accept="image/*"
          className="sr-only"
          disabled={screenshotUploading || submitting}
          onChange={(e) => void handleScreenshotPick(e)}
        />
        {screenshotUrl ? (
          <p className="text-xs text-green-600 dark:text-green-400">{s.payment_screenshot_label}</p>
        ) : null}
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
            setScreenshotUrl(null);
            payTappedAtRef.current = null;
          }}
          className="w-full h-10 rounded-2xl border border-surface-border text-sm font-semibold text-foreground  active:scale-[0.98] transition-transform"
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
      {showUpdatedNotice ? (
        <p
          data-testid={`${idPrefix}-payment-details-updated`}
          className="text-xs text-muted-foreground leading-snug rounded-xl border border-surface-border bg-muted/40 px-3 py-2"
        >
          {qrUrlChanged ? s.payment_details_updated_qr : s.payment_details_updated}
        </p>
      ) : null}
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
          {upiId ? (
            <p
              data-testid={`${idPrefix}-upi-id`}
              className="text-sm text-foreground font-medium break-all text-center"
            >
              {upiId}
            </p>
          ) : null}
          {!payTapped && (
            <button
              type="button"
              onClick={handlePayNowUpi}
              className="w-full h-12 bg-brand text-white font-bold  rounded-2xl text-sm active:scale-[0.98] transition-transform"
            >
              {s.payment_pay_now}
            </button>
          )}
          {returnPromptBlock}
        </div>
      )}

      {activeTab === "mobile" && (
        <div className="space-y-3">
          {vendorPhone ? (
            <p
              data-testid={`${idPrefix}-mobile`}
              className="text-sm text-foreground font-medium text-center"
            >
              {vendorPhone}
            </p>
          ) : null}
          {!payTapped && (
            <button
              type="button"
              onClick={handlePayNowMobile}
              className="w-full h-12 bg-brand text-white font-bold  rounded-2xl text-sm active:scale-[0.98] transition-transform"
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
          ) : (
            <div className="space-y-3">
              {showStaticQrImage ? (
                <img
                  data-testid={`${idPrefix}-qr-image`}
                  src={vendorQrUrl}
                  alt=""
                  className="mx-auto h-[200px] w-[200px] rounded-lg border border-surface-border object-contain"
                />
              ) : null}
              {vendorQrPayeeId ? (
                <>
                  {!payTapped && (
                    <button
                      type="button"
                      onClick={handlePayNowQr}
                      className="w-full h-12 bg-brand text-white font-bold  rounded-2xl text-sm active:scale-[0.98] transition-transform"
                    >
                      {s.payment_pay_now}
                    </button>
                  )}
                  {returnPromptBlock}
                </>
              ) : (
                <>
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
        </div>
      )}

      {showUtrInput && (
        <div className="space-y-2">
          {screenshotBlock}
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
            data-testid={`${idPrefix}-submit-utr`}
            disabled={submitting || screenshotUploading}
            onClick={() => void handleSubmitUtr()}
            className="w-full h-12 bg-brand text-white font-bold  rounded-2xl text-sm active:scale-[0.98] transition-transform disabled:opacity-60"
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
