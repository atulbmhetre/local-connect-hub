import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Loader2 } from "lucide-react";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import {
  supabase,
  useCategoryLabel,
  useServiceModeLabel,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  type Vendor,
} from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { getVoiceLang } from "@/lib/voiceUtils";
import { NetworkExhaustedError, withNetworkRetry } from "@/lib/withNetworkRetry";
import { getNavigatorOnline } from "@/hooks/useNetworkStatus";
import {
  dismissNetworkRetryingToast,
  showNetworkFailedToast,
  showNetworkRetryingToast,
} from "@/lib/networkToast";
import { useAppConfig } from "@/hooks/useAppConfig";
import { Switch } from "@/components/ui/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
  SettingsCollapsible,
  SettingsParentCollapsible,
} from "@/components/settings/SettingsSection";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  isVendorSoundEnabled,
  isVendorVibrateEnabled,
  setVendorSoundEnabled,
  setVendorVibrateEnabled,
} from "@/lib/pushNotifications";
import { formatTimeAgo } from "@/lib/orders";
import { ledgerCycleStartInputValue } from "@/lib/khataDisplay";
import { referralCodeFromPhone } from "@/lib/referral";
import { requestAadhaarDigilockerConsent } from "@/lib/aadhaarDigilocker";
import { getUserPhone } from "@/lib/userIdentity";
import { normalizeServiceRadiusKm } from "@/lib/serviceRadius";
import { withOptionalFeedImageUpload } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { FeedReachChips } from "@/components/FeedReachChips";
import { DEFAULT_FEED_REACH_KM, normalizeFeedReachKm, VENDOR_FEED_REACH_CHIP_OPTIONS } from "@/lib/feedReach";
import { captureError } from "@/lib/sentry";
import { sendVendorReviewReply } from "@/lib/vendorReviewReply";
import {
  type MenuItem,
  type VendorActiveOffer,
} from "@/components/settings/VendorSettingsShared";

export type { MenuItem, VendorActiveOffer } from "@/components/settings/VendorSettingsShared";

export type VendorReferralCredits = {
  total: number;
  pending: number;
  /** True when the credits fetch failed — show "unavailable", not a false ₹0. */
  failed?: boolean;
};

type VendorReview = {
  id: string;
  rating: number;
  review_text: string | null;
  service_mode: string | null;
  created_at: string;
  user_phone: string | null;
  vendor_response: string | null;
  vendor_responded_at: string | null;
};

type Props = {
  vendor: Vendor;
  onVendorUpdated: (updated: Vendor) => void;
  shopOpen: boolean;
  onShopOpenChange: (open: boolean) => void;
  referEarnVisible?: boolean;
  userPhone?: string | null;
  /** Batch-fetched by the parent (Settings) so panels render complete on first paint. */
  referralCredits: VendorReferralCredits;
  /** Deep-link from review_received notification — expand My Reviews on mount. */
  openReviewsInitially?: boolean;
};

/** Order alert toggles (vibrate/sound) for vendor Preferences; native only. */
export function VendorSettingsOrderAlertsContent() {
  const { s } = useLanguage();
  const [vendorVibrate, setVendorVibrate] = useState(() => isVendorVibrateEnabled());
  const [vendorSound, setVendorSound] = useState(() => isVendorSoundEnabled());

  return (
    <>
      <SettingsRow label={s.settings_vibrate}>
        <Switch
          className="data-[state=checked]:bg-brand"
          checked={vendorVibrate}
          onCheckedChange={(checked) => {
            setVendorVibrate(checked);
            setVendorVibrateEnabled(checked);
          }}
        />
      </SettingsRow>
      <SettingsRow label={s.settings_sound} sublabel={s.settings_sound_body}>
        <Switch
          className="data-[state=checked]:bg-brand"
          checked={vendorSound}
          onCheckedChange={(checked) => {
            setVendorSound(checked);
            setVendorSoundEnabled(checked);
          }}
        />
      </SettingsRow>
    </>
  );
}

export function VendorSettingsReferEarn({
  vendor,
  userPhone,
  referralCredits,
}: {
  vendor?: Vendor | null;
  userPhone?: string | null;
  /** Batch-fetched by the parent for vendors; plain users have no credits. */
  referralCredits?: VendorReferralCredits | null;
}) {
  const { s } = useLanguage();
  const { config } = useAppConfig();

  const resolvedVendorCode = vendor?.id
    ? vendor.referral_code?.trim() ||
      referralCodeFromPhone((vendor.phone ?? userPhone ?? "").trim())
    : null;
  const [referralCode, setReferralCode] = useState<string | null>(resolvedVendorCode);
  const creditTotal = referralCredits?.total ?? 0;
  const creditPending = referralCredits?.pending ?? 0;

  useEffect(() => {
    if (!vendor?.id) return;
    setReferralCode(
      vendor.referral_code?.trim() ||
        referralCodeFromPhone((vendor.phone ?? userPhone ?? "").trim()),
    );
  }, [vendor?.id, vendor?.phone, vendor?.referral_code, userPhone]);

  if (!vendor?.id) return null;

  const referLink =
    referralCode != null ? `${config.appBaseUrl}/r/${referralCode}` : null;

  const copyReferralCode = async () => {
    if (!referralCode) return;
    try {
      await navigator.clipboard.writeText(referralCode);
      toast.success(s.vendor_referCodeCopied);
    } catch {
      toast.error(s.referral_copy_failed);
    }
  };

  const shareReferLink = async () => {
    if (!referLink || !referralCode) return;
    const message = s.referral_share_text(referralCode, referLink);
    if (navigator.share) {
      try {
        await navigator.share({ title: s.referral_share_title, text: message });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await navigator.clipboard.writeText(message);
    toast.success(s.vendor_referLinkCopied);
  };

  return (
    <>
      {referralCode != null ? (
        <div className="px-4 py-3 space-y-3">
          <button
            type="button"
            onClick={() => void copyReferralCode()}
            className="flex w-full items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3 text-left transition-colors active:bg-muted"
            aria-label={s.vendor_referCopyCode}
          >
            <span className="font-mono text-base font-semibold tracking-widest text-foreground">
              {referralCode}
            </span>
            <span className="shrink-0 text-base leading-none opacity-70" aria-hidden>
              📋
            </span>
          </button>
          <button
            type="button"
            onClick={() => void shareReferLink()}
            disabled={!referLink}
            className="w-full rounded-2xl bg-secondary text-secondary-foreground px-4 h-12 text-sm font-semibold transition-colors active:scale-[0.99] disabled:opacity-50"
          >
            {s.vendor_referShare}
          </button>
          {referralCredits?.failed ? (
            <p className="text-xs text-muted-foreground pt-1">
              {s.referral_credits_unavailable}
            </p>
          ) : (
            (creditTotal > 0 || creditPending > 0) && (
              <div className="space-y-1 pt-1">
                {creditTotal > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {s.referral_total_earned(creditTotal.toFixed(2))}
                  </p>
                )}
                {creditPending > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {s.referral_pending_payout(creditPending.toFixed(2))}
                  </p>
                )}
              </div>
            )
          )}
        </div>
      ) : null}
      <div className="px-4 pb-3">
        <p className="text-xs text-muted-foreground">
          {s.vendor_referVendorCredit(config.referralVendorCreditTotal)}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {s.vendor_referUserCredit(config.referralUserCredit)}
        </p>
      </div>
    </>
  );
}

export function VendorSettings({
  vendor,
  onVendorUpdated,
  shopOpen,
  onShopOpenChange,
  referEarnVisible = false,
  userPhone,
  referralCredits,
  openReviewsInitially = false,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();
  const { config: appConfig } = useAppConfig();

  const vendorPhone = userPhone ?? getUserPhone()?.trim() ?? null;

  const patchVendor = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!vendorPhone) {
        return { error: { message: "identity_required" } };
      }
      return supabase.rpc("vendor_update_own", {
        p_vendor_id: vendor.id,
        p_vendor_phone: vendorPhone,
        p_patch: patch,
      });
    },
    [vendor.id, vendorPhone],
  );

  const [reviews, setReviews] = useState<VendorReview[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [reviewsFailed, setReviewsFailed] = useState(false);
  const [showReviews, setShowReviews] = useState(openReviewsInitially);
  const [replyingReviewId, setReplyingReviewId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [orderAlertsOpen, setOrderAlertsOpen] = useState(false);
  const [referOpen, setReferOpen] = useState(false);
  const [callReview, setCallReview] = useState<{
    callerPhone: string;
    serviceMode: string;
  } | null>(null);
  const [ledgerCycleStart, setLedgerCycleStart] = useState(() =>
    ledgerCycleStartInputValue(vendor.ledger_cycle_start),
  );
  const [savingLedgerCycleStart, setSavingLedgerCycleStart] = useState(false);
  const [khataCreditOpen, setKhataCreditOpen] = useState(false);
  const [khataDraftOn, setKhataDraftOn] = useState(false);
  const [khataEditMode, setKhataEditMode] = useState(false);
  const [khataAmberInput, setKhataAmberInput] = useState("");
  const [khataRedInput, setKhataRedInput] = useState("");
  const [savingKhataLimits, setSavingKhataLimits] = useState(false);
  const [capturingDraftLocation, setCapturingDraftLocation] = useState(false);
  const billingVendor = vendor as Vendor & {
    subscription_status?: "trial" | "active" | "grace" | "expired" | "cancelled";
    trial_ends_at?: string | null;
    subscription_current_period_end?: string | null;
    grace_ends_at?: string | null;
    waiveoff_percent?: number | null;
    waiveoff_months_remaining?: number | null;
  };

  const subscriptionStatus = billingVendor.subscription_status ?? "trial";
  const formatBillingDate = (value?: string | null) => {
    if (!value) return "—";
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  };
  const trialDaysRemaining = useMemo(() => {
    if (!billingVendor.trial_ends_at) return 0;
    const ms = new Date(billingVendor.trial_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
  }, [billingVendor.trial_ends_at]);
  const graceDaysRemaining = useMemo(() => {
    if (!billingVendor.grace_ends_at) return 0;
    const ms = new Date(billingVendor.grace_ends_at).getTime() - Date.now();
    return Math.max(0, Math.ceil(ms / 86400000));
  }, [billingVendor.grace_ends_at]);
  const waiveoffText =
    billingVendor.waiveoff_percent != null &&
    billingVendor.waiveoff_months_remaining != null &&
    billingVendor.waiveoff_months_remaining > 0
      ? s.vendor_sub_waiveoff
          .replace("{percent}", String(billingVendor.waiveoff_percent))
          .replace("{months}", String(billingVendor.waiveoff_months_remaining))
      : null;

  const handleRazorpayCheckout = useCallback(() => {
    const paymentsEnabled = appConfig?.payments_enabled === "true";
    if (!paymentsEnabled) {
      toast.info(s.vendor_sub_coming_soon);
      return;
    }
    const price = appConfig?.vendor_subscription_price ?? "99";
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => {
      const options = {
        key: appConfig?.razorpay_key_id ?? "",
        amount: parseInt(price) * 100, // paise
        currency: "INR",
        name: "Aaspaas Pro",
        description: "Vendor Subscription — ₹" + price + "/month",
        recurring: 1,
        handler: async (_response: Record<string, string>) => {
          // Subscription activation is server-side only (razorpay-webhook /
          // check-vendor-subscriptions). Client must not patch subscription_*.
          toast.success(s.vendor_sub_active);
        },
        prefill: {
          contact: vendor?.phone ?? "",
          name: vendor?.shop_name ?? "",
        },
        theme: { color: "#16a34a" },
      };
      // @ts-ignore — Razorpay is loaded via script tag
      const rzp = new window.Razorpay(options);
      rzp.open();
    };
    script.onerror = () => toast.error("Failed to load payment gateway. Please try again.");
    document.body.appendChild(script);
  }, [appConfig, vendor, s]);

  const handleAadhaarVerify = useCallback(async () => {
    const enabled = appConfig.aadhaarVerificationEnabled === true;
    if (!enabled) {
      toast.info(s.aadhaar_verify_coming_soon);
      return;
    }
    const phone = vendorPhone?.trim();
    if (!phone) {
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    const result = await requestAadhaarDigilockerConsent({
      enabled: true,
      vendorPhone: phone,
    });
    if (result.ok === false) {
      toast.info(s.aadhaar_verify_coming_soon);
      return;
    }
    window.location.assign(result.authorizationUrl);
  }, [appConfig.aadhaarVerificationEnabled, vendorPhone, s]);

  const handleCancelSubscription = () => {
    const adminPhone =
      (appConfig as unknown as { admin_phone?: string } | null)?.admin_phone ??
      "918888169446";
    const waMsg = encodeURIComponent(
      `Hi, I want to cancel my Aaspaas Pro subscription. Vendor: ${vendor?.shop_name}`,
    );
    window.open(`https://wa.me/${adminPhone}?text=${waMsg}`, "_blank");
  };

  const completeDraftProfile = async () => {
    setCapturingDraftLocation(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
        });
      });
      const latitude = pos.coords.latitude;
      const longitude = pos.coords.longitude;
      const { error } = await patchVendor({
        latitude,
        longitude,
        profile_status: "complete",
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      onVendorUpdated({
        ...vendor,
        latitude,
        longitude,
        profile_status: "complete",
      });
    } catch {
      toast.error(s.vendor_gps_missing_draft);
    } finally {
      setCapturingDraftLocation(false);
    }
  };

  const khataEnabled = (Number(vendor.khata_amber_limit) || 0) > 0;
  const khataSwitchOn = khataEnabled || khataDraftOn;
  const showKhataLimitInputs = khataDraftOn || khataEditMode;

  const aiBridgeVendor: AiBridgeVendor = {
    id: vendor.id,
    name: vendor.name,
    shop_name: vendor.shop_name,
    category: vendor.category,
    vendor_note: vendor.vendor_note ?? null,
    phone: vendor.phone,
    service_mode: vendor.service_mode ?? "help",
    verification_status: vendor.verification_status,
    is_manual_verified: vendor.is_manual_verified,
    total_helped: vendor.total_helped,
    on_time_rate: vendor.on_time_rate,
    shop_photo_url: vendor.shop_photo_url,
    upi_verified: vendor.upi_verified,
  };

  const loadReviews = async () => {
    setReviewsLoading(true);
    const { data, error } = await supabase
      .from("vendor_reviews")
      .select(
        "id, rating, review_text, service_mode, created_at, user_phone, vendor_response, vendor_responded_at",
      )
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false });
    if (error) {
      captureError(error, { scope: "vendorSettings.loadReviews", vendorId: vendor.id });
      console.error("loadReviews", error);
      setReviewsFailed(true);
      setReviews([]);
      setReviewsLoading(false);
      return;
    }
    setReviewsFailed(false);
    setReviews((data ?? []) as VendorReview[]);
    setReviewsLoading(false);
  };

  useEffect(() => {
    if (openReviewsInitially) {
      void loadReviews();
    }
  }, [openReviewsInitially, vendor.id]);

  const sendReviewReply = async (reviewId: string) => {
    const text = replyDraft.trim();
    if (!text || sendingReplyId) return;
    setSendingReplyId(reviewId);
    if (!vendorPhone) {
      setSendingReplyId(null);
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    const result = await sendVendorReviewReply({
      vendorId: vendor.id,
      vendorPhone,
      reviewId,
      response: text,
    });
    setSendingReplyId(null);
    if (result.ok === false) {
      toast.error(result.error.message);
      return;
    }
    setReviews((prev) =>
      prev.map((r) =>
        r.id === reviewId
          ? { ...r, vendor_response: text, vendor_responded_at: result.respondedAt }
          : r,
      ),
    );
    setReplyingReviewId(null);
    setReplyDraft("");
    toast.success(s.review_reply_sent);
  };

  useEffect(() => {
    setLedgerCycleStart(ledgerCycleStartInputValue(vendor.ledger_cycle_start));
  }, [vendor.ledger_cycle_start]);

  useEffect(() => {
    if (khataEnabled) {
      setKhataAmberInput(String(vendor.khata_amber_limit ?? ""));
      setKhataRedInput(String(vendor.khata_red_limit ?? ""));
    }
  }, [khataEnabled, vendor.khata_amber_limit, vendor.khata_red_limit]);

  const saveLedgerCycleStart = async (date: string) => {
    if (!date || savingLedgerCycleStart) return;
    setSavingLedgerCycleStart(true);
    const { error } = await patchVendor({ ledger_cycle_start: date });
    setSavingLedgerCycleStart(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onVendorUpdated({ ...vendor, ledger_cycle_start: date });
    toast.success(s.settings_ledgerCycleUpdated);
  };

  const handleKhataToggle = async (checked: boolean) => {
    if (checked) {
      setKhataDraftOn(true);
      setKhataEditMode(true);
      setKhataAmberInput("");
      setKhataRedInput("");
      return;
    }

    const phoneForKhataCheck = vendorPhone?.trim() || getUserPhone()?.trim();
    if (!phoneForKhataCheck) {
      toast.error(s.khata_disableBlocked);
      return;
    }
    const { data: hasOutstanding, error } = await supabase.rpc(
      "get_vendor_khata_has_outstanding",
      {
        p_vendor_id: vendor.id,
        p_vendor_phone: phoneForKhataCheck,
      },
    );

    if (error) {
      captureError(error, { scope: "vendorSettings.khataDisableCheck", vendorId: vendor.id });
      toast.error(error.message);
      return;
    }
    if (hasOutstanding === true) {
      toast.error(s.khata_disableBlocked);
      return;
    }

    setSavingKhataLimits(true);
    const { error: updateError } = await patchVendor({
      khata_amber_limit: 0,
      khata_red_limit: 0,
    });
    setSavingKhataLimits(false);

    if (updateError) {
      captureError(updateError, { scope: "vendorSettings.khataDisable", vendorId: vendor.id });
      toast.error(updateError.message);
      return;
    }

    onVendorUpdated({ ...vendor, khata_amber_limit: 0, khata_red_limit: 0 });
    setKhataDraftOn(false);
    setKhataEditMode(false);
    setKhataAmberInput("");
    setKhataRedInput("");
  };

  const saveKhataLimits = async () => {
    const amber = parseFloat(khataAmberInput);
    const red = parseFloat(khataRedInput);
    if (!Number.isFinite(amber) || !Number.isFinite(red) || amber <= 0 || red <= amber) {
      toast.error(s.khata_limitInvalid);
      return;
    }

    setSavingKhataLimits(true);
    const { error } = await patchVendor({ khata_amber_limit: amber, khata_red_limit: red });
    setSavingKhataLimits(false);

    if (error) {
      captureError(error, { scope: "vendorSettings.khataSaveLimits", vendorId: vendor.id });
      toast.error(error.message);
      return;
    }

    onVendorUpdated({ ...vendor, khata_amber_limit: amber, khata_red_limit: red });
    setKhataDraftOn(false);
    setKhataEditMode(false);
  };

  return (
    <>
      {vendor.profile_status === "draft" && (
        <div className="mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-2">
          <p className="text-sm font-semibold text-amber-400">{s.vendor_draft_banner_title}</p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            {s.vendor_draft_banner_body}
          </p>
          <button
            type="button"
            disabled={capturingDraftLocation}
            onClick={() => void completeDraftProfile()}
            className="w-full rounded-xl bg-amber-500/20 border border-amber-500/40 text-amber-300 text-sm font-semibold py-2.5 active:scale-[0.99] disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {capturingDraftLocation ? (
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
            ) : null}
            {s.vendor_draft_banner_cta}
          </button>
        </div>
      )}
      <SettingsParentCollapsible
      label={s.settings_preferences}
      open={shopOpen}
      onToggle={() => onShopOpenChange(!shopOpen)}
    >
      <SettingsCard className="mx-0 mb-2 border-surface-border">
        <div className="px-4 py-3 space-y-2">
          {subscriptionStatus === "trial" && (
            <>
              <p className="text-sm font-semibold text-foreground">🎁 {s.vendor_sub_trial}</p>
              <p className="text-xs text-muted-foreground">
                {trialDaysRemaining} {s.vendor_sub_trial_days}
              </p>
              <p className="text-xs text-muted-foreground">{s.vendor_sub_trial_hint}</p>
            </>
          )}

          {subscriptionStatus === "active" && (
            <>
              <p className="text-sm font-semibold text-foreground">✅ {s.vendor_sub_active}</p>
              <p className="text-xs text-muted-foreground">
                {s.vendor_sub_next_billing}:{" "}
                <span className="text-foreground">
                  {formatBillingDate(billingVendor.subscription_current_period_end)}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">₹99/month</p>
              {waiveoffText && <p className="text-xs text-muted-foreground">{waiveoffText}</p>}
              <button
                type="button"
                onClick={handleCancelSubscription}
                className="mt-1 w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.99]"
              >
                {s.vendor_sub_cancel}
              </button>
            </>
          )}

          {subscriptionStatus === "grace" && (
            <>
              <p className="text-sm font-semibold text-amber-400">⚠️ {s.vendor_sub_grace}</p>
              <p className="text-xs text-muted-foreground">
                {graceDaysRemaining} {s.vendor_sub_trial_days}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.vendor_sub_grace_ends}:{" "}
                <span className="text-foreground">{formatBillingDate(billingVendor.grace_ends_at)}</span>
              </p>
              <button
                type="button"
                onClick={handleRazorpayCheckout}
                className="mt-1 w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.99]"
              >
                {s.vendor_sub_pay_now}
              </button>
            </>
          )}

          {subscriptionStatus === "expired" && (
            <>
              <p className="text-sm font-semibold text-destructive">🔴 {s.vendor_sub_expired}</p>
              <p className="text-xs text-muted-foreground">{s.vendor_sub_expired_body}</p>
              <button
                type="button"
                onClick={handleRazorpayCheckout}
                className="mt-1 w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.99]"
              >
                {s.vendor_sub_renew}
              </button>
            </>
          )}

          {subscriptionStatus === "cancelled" && (
            <>
              <p className="text-sm font-semibold text-foreground">ℹ️ {s.vendor_sub_cancelled}</p>
              <p className="text-xs text-muted-foreground">{s.vendor_sub_cancelled_body}</p>
              <button
                type="button"
                onClick={handleRazorpayCheckout}
                className="mt-1 w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.99]"
              >
                {s.vendor_sub_renew}
              </button>
            </>
          )}
        </div>
      </SettingsCard>

      <SettingsCard className="mx-0 mb-2 border-surface-border">
        <div className="px-4 py-3 space-y-2">
          <p className="text-sm font-semibold text-foreground">{s.aadhaar_verify_title}</p>
          <p className="text-xs text-muted-foreground">{s.aadhaar_verify_body}</p>
          <button
            type="button"
            data-testid="aadhaar-digilocker-verify-btn"
            onClick={() => void handleAadhaarVerify()}
            className="mt-1 w-full rounded-xl border border-border h-10 text-sm font-semibold text-foreground active:scale-[0.99]"
          >
            {s.aadhaar_verify_cta}
          </button>
        </div>
      </SettingsCard>

      {Capacitor.isNativePlatform() && (
        <SettingsCollapsible
          label={s.settings_order_alerts}
          open={orderAlertsOpen}
          onToggle={() => setOrderAlertsOpen((o) => !o)}
          nested
          testId="settings-order-alerts-toggle"
        >
          <div className="px-0" data-testid="settings-order-alerts">
            <VendorSettingsOrderAlertsContent />
          </div>
        </SettingsCollapsible>
      )}

      <SettingsCollapsible
        label={s.vendor_ledgerCycleStart}
        open={ledgerOpen}
        onToggle={() => setLedgerOpen((o) => !o)}
        nested
      >
        <div className="px-4 py-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            {s.vendor_ledgerCycleStartHint}
          </p>
          <input
            id="ledger-cycle-start"
            type="date"
            value={ledgerCycleStart}
            disabled={savingLedgerCycleStart}
            onChange={(e) => {
              const next = e.target.value;
              setLedgerCycleStart(next);
              void saveLedgerCycleStart(next);
            }}
            className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          />
        </div>
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.khata_creditSettings}
        open={khataCreditOpen}
        onToggle={() => setKhataCreditOpen((o) => !o)}
        nested
      >
        <div className="px-4 py-3 space-y-3">
          <SettingsRow label={s.khata_enableKhata}>
            <Switch
              className="data-[state=checked]:bg-brand"
              checked={khataSwitchOn}
              disabled={savingKhataLimits}
              onCheckedChange={(checked) => void handleKhataToggle(checked)}
            />
          </SettingsRow>

          {!khataSwitchOn && (
            <p className="text-xs text-muted-foreground">{s.khata_disabledHint}</p>
          )}

          {khataEnabled && !showKhataLimitInputs && (
            <div className="rounded-xl border border-surface-border bg-surface/80 px-3 py-2.5 space-y-1">
              <p className="text-xs text-foreground">
                {s.khata_amberLimit}:{" "}
                <span className="font-semibold tabular-nums">
                  ₹{Number(vendor.khata_amber_limit).toFixed(0)}
                </span>
              </p>
              <p className="text-xs text-foreground">
                {s.khata_redLimit}:{" "}
                <span className="font-semibold tabular-nums">
                  ₹{Number(vendor.khata_red_limit).toFixed(0)}
                </span>
              </p>
              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setKhataEditMode(true);
                    setKhataAmberInput(String(vendor.khata_amber_limit ?? ""));
                    setKhataRedInput(String(vendor.khata_red_limit ?? ""));
                  }}
                  className="text-xs font-semibold text-brand active:opacity-80"
                >
                  {s.review_edit}
                </button>
              </div>
            </div>
          )}

          {showKhataLimitInputs && (
            <div className="space-y-2">
              <label className="block">
                <span className="text-xs text-muted-foreground">{s.khata_amberLimit}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={khataAmberInput}
                  disabled={savingKhataLimits}
                  onChange={(e) => setKhataAmberInput(e.target.value)}
                  className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                />
              </label>
              <label className="block">
                <span className="text-xs text-muted-foreground">{s.khata_redLimit}</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={khataRedInput}
                  disabled={savingKhataLimits}
                  onChange={(e) => setKhataRedInput(e.target.value)}
                  className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                />
              </label>
              <div className="flex justify-end gap-2 pt-1">
                {khataEnabled && (
                  <button
                    type="button"
                    disabled={savingKhataLimits}
                    onClick={() => {
                      setKhataEditMode(false);
                      setKhataAmberInput(String(vendor.khata_amber_limit ?? ""));
                      setKhataRedInput(String(vendor.khata_red_limit ?? ""));
                    }}
                    className="text-xs font-semibold text-muted-foreground active:opacity-80 disabled:opacity-50"
                  >
                    {s.settings_cancel}
                  </button>
                )}
                <button
                  type="button"
                  disabled={savingKhataLimits}
                  onClick={() => void saveKhataLimits()}
                  className="text-xs font-semibold text-brand active:opacity-80 disabled:opacity-50"
                >
                  {savingKhataLimits ? s.incoming_saving : s.menu_save}
                </button>
              </div>
            </div>
          )}
        </div>
      </SettingsCollapsible>

      {referEarnVisible && (
        <SettingsCollapsible
          label={s.vendor_referEarn}
          open={referOpen}
          onToggle={() => setReferOpen((o) => !o)}
          nested
        >
          <VendorSettingsReferEarn
            vendor={vendor}
            userPhone={userPhone}
            referralCredits={referralCredits}
          />
        </SettingsCollapsible>
      )}

      <SettingsCollapsible
        label={
          reviewsFailed
            ? `⭐ ${s.review_myReviews}`
            : `⭐ ${s.review_myReviews} (${reviews.length})`
        }
        open={showReviews}
        onToggle={() => {
          setShowReviews((p) => {
            const next = !p;
            if (next) void loadReviews();
            return next;
          });
        }}
        nested
      >
        {reviewsLoading && (
          <p className="text-xs text-muted-foreground px-4 py-3">{s.settings_loading}</p>
        )}
        {!reviewsLoading && reviewsFailed && (
          <div className="px-4 py-3 space-y-2">
            <p className="text-xs text-destructive">{s.review_unavailable}</p>
            <button
              type="button"
              onClick={() => void loadReviews()}
              className="rounded-lg border border-surface-border px-2.5 py-1 text-xs font-semibold text-foreground"
            >
              {s.network_retry_btn}
            </button>
          </div>
        )}
        {!reviewsLoading && !reviewsFailed && reviews.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-3">{s.review_noReviews}</p>
        )}
        <div className="px-4 pb-3 space-y-2">
          {reviews.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-surface-border bg-surface/80 px-3 py-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-foreground">
                    {"⭐".repeat(r.rating)}
                    {"☆".repeat(5 - r.rating)}
                  </p>
                  {r.review_text && (
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      &quot;{r.review_text}&quot;
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    — {s.review_anonymous}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatTimeAgo(r.created_at)}
                  </p>
                </div>
                {r.rating <= 2 && r.user_phone && (
                  <button
                    type="button"
                    onClick={() =>
                      setCallReview({
                        callerPhone: r.user_phone!,
                        serviceMode: r.service_mode ?? vendor.service_mode ?? "help",
                      })
                    }
                    className="shrink-0 text-xs font-semibold text-brand active:opacity-80"
                  >
                    {s.settings_callCustomer}
                  </button>
                )}
              </div>
              {r.vendor_response?.trim() ? (
                <div className="mt-2 pt-2 border-t border-surface-border">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {s.review_your_reply}
                  </p>
                  <p className="text-xs text-foreground mt-1 leading-relaxed">{r.vendor_response}</p>
                  {r.vendor_responded_at && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatTimeAgo(r.vendor_responded_at)}
                    </p>
                  )}
                </div>
              ) : replyingReviewId === r.id ? (
                <div className="mt-2 pt-2 border-t border-surface-border space-y-2">
                  <textarea
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value.slice(0, 200))}
                    rows={2}
                    placeholder={s.review_reply_placeholder}
                    className="w-full rounded-lg border border-surface-border bg-surface px-2.5 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                  <button
                    type="button"
                    disabled={!replyDraft.trim() || sendingReplyId === r.id}
                    onClick={() => void sendReviewReply(r.id)}
                    className="w-full rounded-lg bg-brand text-white text-xs font-semibold py-2 disabled:opacity-50"
                  >
                    {sendingReplyId === r.id ? s.incoming_saving : s.review_send}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setReplyingReviewId(r.id);
                    setReplyDraft("");
                  }}
                  className="mt-2 text-xs font-semibold text-brand active:opacity-80"
                >
                  {s.review_respond}
                </button>
              )}
            </div>
          ))}
        </div>
      </SettingsCollapsible>

      {callReview && (
        <AiBridgeSheet
          open={callReview !== null}
          onClose={() => setCallReview(null)}
          vendor={aiBridgeVendor}
          callerPhone={callReview.callerPhone}
          userNeed=""
          distanceKm={null}
        />
      )}
    </SettingsParentCollapsible>
    </>
  );
}
