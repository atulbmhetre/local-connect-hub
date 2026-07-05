import { useCallback, useEffect, useMemo, useState } from "react";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import { Bell, Pencil, Trash2, Mic, Camera, Loader2 } from "lucide-react";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";
import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { toast } from "sonner";
import { ServiceRadiusChips } from "@/components/ServiceRadiusChips";
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
import { persistVendorServiceRadius } from "@/lib/vendorServiceRadius";
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
import { getUserPhone } from "@/lib/userIdentity";
import { normalizeServiceRadiusKm } from "@/lib/serviceRadius";
import { uploadFeedImage } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { FeedReachChips } from "@/components/FeedReachChips";
import { DEFAULT_FEED_REACH_KM, normalizeFeedReachKm } from "@/lib/feedReach";

export type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: string | null;
  is_available: boolean;
  sort_order: number;
};

export type VendorActiveOffer = {
  id: string;
  content: string;
  expires_at: string | null;
};

export type VendorReferralCredits = {
  total: number;
  pending: number;
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
  onEditShopDetails?: () => void;
  shopOpen: boolean;
  onShopOpenChange: (open: boolean) => void;
  referEarnVisible?: boolean;
  userPhone?: string | null;
  /** Batch-fetched by the parent (Settings) so panels render complete on first paint. */
  activeOffer: VendorActiveOffer | null;
  referralCredits: VendorReferralCredits;
  menuItems: MenuItem[];
};

function offerDateInputMin() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function offerDateToStartIso(dateStr: string) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function offerDateToEndIso(dateStr: string) {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, m - 1, day);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export function VendorSettingsOffers({
  vendorId,
  activeOffer: initialActiveOffer,
  vendorLatitude,
  vendorLongitude,
  shopName,
  vendorServiceRadiusKm,
}: {
  vendorId: string;
  /** Batch-fetched by the parent; refetched locally only after posting an offer. */
  activeOffer: VendorActiveOffer | null;
  vendorLatitude: number | null;
  vendorLongitude: number | null;
  shopName: string;
  vendorServiceRadiusKm: number;
}) {
  const { s } = useLanguage();
  const [activeOffer, setActiveOffer] = useState<VendorActiveOffer | null>(initialActiveOffer);
  const [offerText, setOfferText] = useState("");
  const [offerStartsAt, setOfferStartsAt] = useState("");
  const [offerEndsAt, setOfferEndsAt] = useState("");
  const [offerStartError, setOfferStartError] = useState("");
  const [offerEndError, setOfferEndError] = useState("");
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerImageFile, setOfferImageFile] = useState<File | null>(null);
  const [offerImagePreview, setOfferImagePreview] = useState<string | null>(null);
  const [offersOpen, setOffersOpen] = useState(false);
  const [offerReachKm, setOfferReachKm] = useState(() =>
    normalizeFeedReachKm(vendorServiceRadiusKm),
  );

  const loadActiveOffer = useCallback(async () => {
    const { data, error } = await supabase
      .from("feed_posts")
      .select("*")
      .eq("vendor_id", vendorId)
      .eq("type", "offer")
      .eq("is_hidden", false)
      .gt("expires_at", new Date().toISOString())
      .or("starts_at.is.null,starts_at.lte.now()")
      .maybeSingle();
    if (error) {
      console.error("loadActiveOffer", error);
      setActiveOffer(null);
      return;
    }
    setActiveOffer(
      data
        ? {
            id: data.id as string,
            content: (data.content as string) ?? "",
            expires_at: (data.expires_at as string | null) ?? null,
          }
        : null,
    );
  }, [vendorId]);

  const resetOfferImage = () => {
    setOfferImageFile(null);
    if (offerImagePreview) URL.revokeObjectURL(offerImagePreview);
    setOfferImagePreview(null);
  };

  const onOfferImagePick = (file: File) => {
    setOfferImageFile(file);
    if (offerImagePreview) URL.revokeObjectURL(offerImagePreview);
    setOfferImagePreview(URL.createObjectURL(file));
  };

  const validateOfferDates = (): boolean => {
    const minDate = offerDateInputMin();
    let ok = true;

    if (!offerStartsAt || offerStartsAt < minDate) {
      setOfferStartError(s.vendor_offer_start_required);
      ok = false;
    } else {
      setOfferStartError("");
    }

    if (!offerEndsAt || (offerStartsAt && offerEndsAt <= offerStartsAt)) {
      setOfferEndError(s.vendor_offer_end_required);
      ok = false;
    } else {
      setOfferEndError("");
    }

    return ok;
  };

  const postOffer = async () => {
    const content = offerText.trim();
    if (!content) return;
    if (!validateOfferDates()) return;
    const phone = getUserPhone();
    if (!phone) {
      toast.error(s.vendor_offer_phone_required);
      return;
    }
    setOfferLoading(true);
    let imageUrl: string | null = null;
    if (offerImageFile) {
      try {
        imageUrl = await uploadFeedImage(offerImageFile, "offers");
      } catch (err) {
        console.error("postOffer upload", err);
        toast.error(s.vendor_offer_image_upload_failed);
        setOfferLoading(false);
        return;
      }
    }
    const lat = vendorLatitude;
    const lng = vendorLongitude;
    if (
      lat == null ||
      lng == null ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      toast.error(s.vendor_offer_location_required);
      setOfferLoading(false);
      return;
    }
    const { error } = await supabase.rpc("vendor_post_offer", {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_content: content,
      p_starts_at: offerDateToStartIso(offerStartsAt),
      p_expires_at: offerDateToEndIso(offerEndsAt),
      p_image_url: imageUrl,
      p_lat: lat,
      p_lng: lng,
      p_reach_radius_km: normalizeFeedReachKm(offerReachKm),
    });
    setOfferLoading(false);
    if (error) {
      console.error("postOffer", error);
      toast.error(error.message);
      return;
    }
    setOfferText("");
    setOfferStartsAt("");
    setOfferEndsAt("");
    setOfferStartError("");
    setOfferEndError("");
    resetOfferImage();
    await loadActiveOffer();
    toast(s.vendor_offer_posted);
  };

  const removeOffer = async () => {
    if (!activeOffer) return;
    const phone = getUserPhone();
    if (!phone) {
      toast.error(s.vendor_offer_phone_required);
      return;
    }
    setOfferLoading(true);
    const { error } = await supabase.rpc("vendor_hide_feed_post", {
      p_vendor_id: vendorId,
      p_vendor_phone: phone,
      p_post_id: activeOffer.id,
    });
    setOfferLoading(false);
    if (error) {
      console.error("removeOffer", error);
      toast.error(error.message);
      return;
    }
    setActiveOffer(null);
    toast(s.vendor_offer_removed);
  };

  return (
    <SettingsCollapsible
      label={s.settings_offers}
      open={offersOpen}
      onToggle={() => setOffersOpen((o) => !o)}
      nested
    >
      {activeOffer ? (
          <div className="px-4 py-3.5 space-y-3">
            <p className="text-sm text-foreground">{activeOffer.content}</p>
            <p className="text-xs text-muted-foreground">
              {s.vendor_offer_expires_label}{" "}
              {activeOffer.expires_at
                ? new Date(activeOffer.expires_at).toLocaleString()
                : "—"}
            </p>
            <button
              type="button"
              onClick={() => void removeOffer()}
              disabled={offerLoading}
              className="w-full rounded-xl border border-destructive/40 text-destructive py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {s.vendor_offer_remove_btn}
            </button>
          </div>
        ) : (
          <div className="px-4 py-3.5 space-y-3">
            <input
              type="text"
              maxLength={100}
              value={offerText}
              onChange={(e) => setOfferText(e.target.value)}
              placeholder={s.vendor_offer_placeholder}
              className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:border-brand"
            />
            <FeedImagePicker
              label={s.settings_addPhotoOptional}
              previewUrl={offerImagePreview}
              onPick={onOfferImagePick}
            />
            <div>
              <label
                htmlFor="vendor-offer-starts"
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5"
              >
                {s.vendor_offer_starts_label}
              </label>
              <input
                id="vendor-offer-starts"
                type="date"
                min={offerDateInputMin()}
                value={offerStartsAt}
                onChange={(e) => {
                  setOfferStartsAt(e.target.value);
                  if (offerStartError) setOfferStartError("");
                }}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {offerStartError && (
                <p className="text-xs text-destructive mt-1">{offerStartError}</p>
              )}
            </div>
            <div>
              <label
                htmlFor="vendor-offer-ends"
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5"
              >
                {s.vendor_offer_ends_label}
              </label>
              <input
                id="vendor-offer-ends"
                type="date"
                min={offerStartsAt || offerDateInputMin()}
                value={offerEndsAt}
                onChange={(e) => {
                  setOfferEndsAt(e.target.value);
                  if (offerEndError) setOfferEndError("");
                }}
                className="w-full bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              />
              {offerEndError && (
                <p className="text-xs text-destructive mt-1">{offerEndError}</p>
              )}
            </div>
            <div className="space-y-2">
              <SettingsSectionLabel>{s.feed_reachLabel}</SettingsSectionLabel>
              <FeedReachChips
                mode="poster"
                value={offerReachKm}
                onChange={(km) => setOfferReachKm(normalizeFeedReachKm(km ?? DEFAULT_FEED_REACH_KM))}
              />
            </div>
            <button
              type="button"
              onClick={() => void postOffer()}
              disabled={offerLoading || offerText.trim().length === 0}
              className="w-full rounded-xl bg-brand text-page-bg py-3 text-sm font-bold disabled:opacity-50 active:scale-[0.99]"
            >
              {s.settings_postOffer}
            </button>
          </div>
        )}
    </SettingsCollapsible>
  );
}

/** Order alert toggles (vibrate/sound) for nested MY SHOP section; native only. */
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
        <div className="px-4 py-3.5 space-y-3">
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
            className="w-full rounded-2xl bg-secondary text-secondary-foreground px-4 py-3 text-sm font-semibold transition-colors active:scale-[0.99] disabled:opacity-50"
          >
            {s.vendor_referShare}
          </button>
          {(creditTotal > 0 || creditPending > 0) && (
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
          )}
        </div>
      ) : null}
      <div className="px-4 pb-3.5">
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
  onEditShopDetails,
  shopOpen,
  onShopOpenChange,
  referEarnVisible = false,
  userPhone,
  activeOffer,
  referralCredits,
  menuItems: initialMenuItems,
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

  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [cancelReasonsChanged, setCancelReasonsChanged] = useState(false);
  const [savingReasons, setSavingReasons] = useState(false);
  const [menuItems, setMenuItems] = useState<MenuItem[]>(initialMenuItems);
  const [menuLoading, setMenuLoading] = useState(false);
  const [editingMenuItem, setEditingMenuItem] = useState<MenuItem | null>(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    price: "",
    unit: "",
    description: "",
  });
  const [newItem, setNewItem] = useState({ name: "", price: "", unit: "", description: "" });
  const [addingItem, setAddingItem] = useState(false);
  const [isListeningMenu, setIsListeningMenu] = useState(false);
  const [isProcessingImageMenu, setIsProcessingImageMenu] = useState(false);
  const [reviews, setReviews] = useState<VendorReview[]>([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [showReviews, setShowReviews] = useState(false);
  const [replyingReviewId, setReplyingReviewId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [sendingReplyId, setSendingReplyId] = useState<string | null>(null);
  const [shopInfoOpen, setShopInfoOpen] = useState(false);
  const [savingServiceRadius, setSavingServiceRadius] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
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
        handler: async (response: Record<string, string>) => {
          // Payment success — update subscription_status to active
          const vendorPhone = getUserPhone()?.trim();
          if (!vendorPhone) return;
          await supabase.rpc("vendor_update_own", {
            p_vendor_id: vendor?.id,
            p_vendor_phone: vendorPhone,
            p_patch: {
              subscription_status: "active",
              subscription_id: response.razorpay_subscription_id ?? response.razorpay_payment_id,
              grace_ends_at: null,
            },
          });
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
  }, [appConfig, vendor, s, supabase]);

  const handleCancelSubscription = () => {
    const adminPhone =
      (appConfig as unknown as { admin_phone?: string } | null)?.admin_phone ??
      "918888169446";
    const waMsg = encodeURIComponent(
      `Hi, I want to cancel my Aaspaas Pro subscription. Vendor: ${vendor?.shop_name}`,
    );
    window.open(`https://wa.me/${adminPhone}?text=${waMsg}`, "_blank");
  };

  const handleServiceRadiusChange = async (km: number) => {
    if (km === normalizeServiceRadiusKm(vendor.service_radius_km)) return;
    if (!vendorPhone) {
      toast.error(s.vendor_radius_save_error);
      return;
    }
    setSavingServiceRadius(true);
    try {
      const result = await withNetworkRetry(
        () => persistVendorServiceRadius(vendor.id, vendorPhone, km),
        {
          onRetrying: () => {
            showNetworkRetryingToast({ retrying: s.network_retrying });
          },
          shouldRetry: () => getNavigatorOnline(),
        },
      );
      dismissNetworkRetryingToast();
      if (!result.ok) {
        toast.error(s.vendor_radius_save_error);
        return;
      }
      onVendorUpdated({ ...vendor, service_radius_km: km });
      toast.success(s.vendor_radius_saved);
    } catch (err) {
      dismissNetworkRetryingToast();
      if (err instanceof NetworkExhaustedError) {
        showNetworkFailedToast(() => void handleServiceRadiusChange(km), {
          failed: s.network_failed,
          retryBtn: s.network_retry_btn,
        });
      } else {
        throw err;
      }
    } finally {
      setSavingServiceRadius(false);
    }
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
    const { data } = await supabase
      .from("vendor_reviews")
      .select(
        "id, rating, review_text, service_mode, created_at, user_phone, vendor_response, vendor_responded_at",
      )
      .eq("vendor_id", vendor.id)
      .order("created_at", { ascending: false });
    setReviews((data ?? []) as VendorReview[]);
    setReviewsLoading(false);
  };

  const sendReviewReply = async (reviewId: string) => {
    const text = replyDraft.trim();
    if (!text || sendingReplyId) return;
    setSendingReplyId(reviewId);
    const respondedAt = new Date().toISOString();
    if (!vendorPhone) {
      setSendingReplyId(null);
      toast.error(s.incoming_errCouldNotUpdate);
      return;
    }
    const { error } = await supabase.rpc("vendor_reply_to_review", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_review_id: reviewId,
      p_response: text,
    });
    setSendingReplyId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    setReviews((prev) =>
      prev.map((r) =>
        r.id === reviewId
          ? { ...r, vendor_response: text, vendor_responded_at: respondedAt }
          : r,
      ),
    );
    setReplyingReviewId(null);
    setReplyDraft("");
    toast.success(s.review_reply_sent);
  };

  // Initial menu comes from the parent's batch fetch; loadMenu only re-runs
  // after in-panel mutations (add/edit/delete/toggle/voice/scan).
  const loadMenu = useCallback(async () => {
    setMenuLoading(true);
    const { data } = await supabase
      .from("vendor_menu_items")
      .select("*")
      .eq("vendor_id", vendor.id)
      .order("sort_order", { ascending: true });
    setMenuItems(data ?? []);
    setMenuLoading(false);
  }, [vendor.id]);

  useEffect(() => {
    setCancelReasons([
      vendor.cancel_reason_1 ?? "",
      vendor.cancel_reason_2 ?? "",
      vendor.cancel_reason_3 ?? "",
      vendor.cancel_reason_4 ?? "",
    ]);
    setCancelReasonsChanged(false);
  }, [
    vendor.cancel_reason_1,
    vendor.cancel_reason_2,
    vendor.cancel_reason_3,
    vendor.cancel_reason_4,
  ]);

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

    const { data, error } = await supabase
      .from("khata_ledger")
      .select("id")
      .eq("vendor_id", vendor.id)
      .gt("total_outstanding", 0)
      .limit(1);

    if (error) {
      toast.error(error.message);
      return;
    }
    if (data?.length) {
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
      toast.error(error.message);
      return;
    }

    onVendorUpdated({ ...vendor, khata_amber_limit: amber, khata_red_limit: red });
    setKhataDraftOn(false);
    setKhataEditMode(false);
  };

  const saveCancelReasons = async () => {
    setSavingReasons(true);
    const updates = {
      cancel_reason_1: cancelReasons[0].trim() || null,
      cancel_reason_2: cancelReasons[1].trim() || null,
      cancel_reason_3: cancelReasons[2].trim() || null,
      cancel_reason_4: cancelReasons[3].trim() || null,
    };
    const { error } = await patchVendor(updates);
    setSavingReasons(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onVendorUpdated({ ...vendor, ...updates });
    setCancelReasonsChanged(false);
    toast.success(s.vendor_settings_saved);
  };

  const saveNewItem = async () => {
    if (!newItem.name.trim() || !newItem.price || !vendorPhone) return;
    await supabase.rpc("vendor_insert_menu_items", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_items: [
        {
          name: newItem.name.trim(),
          price: parseFloat(newItem.price),
          unit: newItem.unit.trim() || null,
          description: newItem.description.trim() || null,
          sort_order: menuItems.length,
        },
      ],
    });
    setNewItem({ name: "", price: "", unit: "", description: "" });
    setAddingItem(false);
    void loadMenu();
  };

  const saveEditedMenuItem = async () => {
    if (!editingMenuItem || !editDraft.name.trim() || !editDraft.price || !vendorPhone) return;
    await supabase.rpc("vendor_update_menu_item", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: editingMenuItem.id,
      p_name: editDraft.name.trim(),
      p_price: parseFloat(editDraft.price),
      p_unit: editDraft.unit.trim() || null,
      p_description: editDraft.description.trim() || null,
    });
    setEditingMenuItem(null);
    void loadMenu();
  };

  const toggleAvailability = async (item: MenuItem) => {
    if (!vendorPhone) return;
    await supabase.rpc("vendor_toggle_menu_item_availability", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: item.id,
    });
    void loadMenu();
  };

  const deleteMenuItem = async (id: string) => {
    if (!vendorPhone) return;
    await supabase.rpc("vendor_delete_menu_item", {
      p_vendor_id: vendor.id,
      p_vendor_phone: vendorPhone,
      p_item_id: id,
    });
    void loadMenu();
  };

  const startVoiceMenu = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.vendor_voice_not_available);
        return;
      }
      await SpeechRecognition.requestPermissions();
      setIsListeningMenu(true);
      const speechResult = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      const text = speechResult?.matches?.[0]?.trim();
      if (!text) return;

      const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-voice-bill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ text }),
      });
      const result = await resp.json();
      if (result.success && result.items?.length && vendorPhone) {
        await supabase.rpc("vendor_insert_menu_items", {
          p_vendor_id: vendor.id,
          p_vendor_phone: vendorPhone,
          p_items: result.items.map(
            (
              item: { description?: string; unit_price?: number; unit?: string },
              idx: number,
            ) => ({
              name: item.description ?? "",
              price: item.unit_price ?? 0,
              unit: item.unit || null,
              sort_order: menuItems.length + idx,
            }),
          ),
        });
        void loadMenu();
        toast.success(s.menu_voiceAdded);
      } else {
        toast.error(s.voice_failed);
      }
    } catch {
      // user cancelled or denied — silent
    } finally {
      setIsListeningMenu(false);
    }
  };

  const startImageMenu = async () => {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.capture = "environment";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        setIsProcessingImageMenu(true);
        const base64 = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res((reader.result as string).split(",")[1]);
          reader.onerror = rej;
          reader.readAsDataURL(file);
        });
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/parse-image-bill`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ image_base64: base64, media_type: file.type }),
        });
        const result = await resp.json();
        if (result.success && result.items?.length && vendorPhone) {
          await supabase.rpc("vendor_insert_menu_items", {
            p_vendor_id: vendor.id,
            p_vendor_phone: vendorPhone,
            p_items: result.items.map(
              (
                item: { description?: string; unit_price?: number; unit?: string },
                idx: number,
              ) => ({
                name: item.description ?? "",
                price: item.unit_price ?? 0,
                unit: item.unit || null,
                sort_order: menuItems.length + idx,
              }),
            ),
          });
          void loadMenu();
          toast.success(s.menu_imageAdded);
        } else {
          toast.error(s.image_failed);
        }
        setIsProcessingImageMenu(false);
      };
      input.click();
    } catch {
      toast.error(s.image_failed);
      setIsProcessingImageMenu(false);
    }
  };

  const serviceModeLabel = s.settings_check7.replace(/\s*\(.*$/, "").replace(/\s+is correct$/i, "");

  return (
    <>
      {vendor.profile_status === "draft" && (
        <div className="mx-4 mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 space-y-2">
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
      label={s.settings_myShop}
      open={shopOpen}
      onToggle={() => onShopOpenChange(!shopOpen)}
    >
      <SettingsCard className="mx-0 mb-2 border-surface-border">
        <div className="px-4 py-3.5 space-y-2">
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
                className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm font-semibold text-foreground active:scale-[0.99]"
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
                className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm font-semibold text-foreground active:scale-[0.99]"
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
                className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm font-semibold text-foreground active:scale-[0.99]"
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
                className="mt-1 w-full rounded-xl border border-border py-2.5 text-sm font-semibold text-foreground active:scale-[0.99]"
              >
                {s.vendor_sub_renew}
              </button>
            </>
          )}
        </div>
      </SettingsCard>

      <SettingsCollapsible
        label={s.settings_shopInfo}
        open={shopInfoOpen}
        onToggle={() => setShopInfoOpen((o) => !o)}
        nested
      >
        <SettingsRow label={s.vendor_shop_name} sublabel={vendor.shop_name}>
          <span aria-hidden />
        </SettingsRow>
        <SettingsRow label={s.vendor_category_label} sublabel={getLabel(vendor.category)}>
          <span aria-hidden />
        </SettingsRow>
        <SettingsRow
          label={serviceModeLabel}
          sublabel={getMode(vendor.service_mode ?? "help")}
        >
          <span aria-hidden />
        </SettingsRow>
        <div className="px-4 py-3.5 border-t border-surface-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {s.vendor_radius_label}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{s.vendor_radius_hint}</p>
          <div className="mt-3">
            <ServiceRadiusChips
              value={normalizeServiceRadiusKm(vendor.service_radius_km)}
              onChange={(km) => void handleServiceRadiusChange(km)}
              disabled={savingServiceRadius}
            />
          </div>
        </div>
        {onEditShopDetails && (
          <button
            type="button"
            onClick={onEditShopDetails}
            className="w-full px-4 py-3.5 border-t border-surface-border text-sm font-semibold text-brand text-center active:opacity-90"
          >
            {s.settings_editShopDetails}
          </button>
        )}
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.vendor_note_customers}
        open={noteOpen}
        onToggle={() => setNoteOpen((o) => !o)}
        nested
      >
        <div className="p-4">
          <VendorNoteEditor
            vendorId={vendor.id}
            initialNote={vendor.vendor_note ?? null}
            onSaved={(newNote) => onVendorUpdated({ ...vendor, vendor_note: newNote || null })}
            showLabel={false}
            className="mt-0"
          />
        </div>
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.menu_title}
        badge={
          <span className="text-[10px] font-semibold text-muted-foreground normal-case tracking-normal">
            {menuItems.length} items
          </span>
        }
        open={menuOpen}
        onToggle={() => setMenuOpen((o) => !o)}
        nested
      >
        <div className="flex items-center justify-end gap-2 px-4 py-2 border-b border-surface-border">
          <button
            type="button"
            onClick={() => void startImageMenu()}
            disabled={isProcessingImageMenu}
            className="p-1.5 rounded-lg border border-surface-border bg-surface text-muted-foreground active:text-brand disabled:opacity-50"
          >
            {isProcessingImageMenu ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Camera className="h-3.5 w-3.5" />
            )}
          </button>
          {Capacitor.isNativePlatform() &&
            (isListeningMenu ? (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-2.5 py-1.5 shrink-0">
                <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse shrink-0" />
                <span className="text-[10px] font-semibold text-red-500 whitespace-nowrap">
                  {s.settings_listeningSpeak}
                </span>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => void startVoiceMenu()}
                className="p-1.5 rounded-lg border border-surface-border bg-surface text-muted-foreground active:text-brand shrink-0"
                aria-label={s.menu_voicePrompt}
              >
                <Mic className="h-3.5 w-3.5" />
              </button>
            ))}
        </div>

        {menuLoading && (
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.settings_loading}</p>
        )}

        {!menuLoading && menuItems.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.menu_empty}</p>
        )}

        {menuItems.map((item) => (
          <SettingsRow
            key={item.id}
            label={item.name}
            sublabel={
              <>
                {item.description && (
                  <span className="block truncate">{item.description}</span>
                )}
                <span className="text-brand font-semibold">
                  ₹{item.price}
                  {item.unit ? `/${item.unit}` : ""}
                </span>
              </>
            }
          >
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void toggleAvailability(item)}
                className={cn(
                  "text-xs px-2 py-1 rounded-lg border whitespace-nowrap",
                  item.is_available
                    ? "border-brand/40 text-brand"
                    : "border-surface-border text-muted-foreground",
                )}
              >
                {item.is_available ? s.menu_available : s.menu_unavailable}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingMenuItem(item);
                  setEditDraft({
                    name: item.name,
                    price: String(item.price),
                    unit: item.unit ?? "",
                    description: item.description ?? "",
                  });
                }}
                className="p-1.5 text-muted-foreground active:text-brand"
                aria-label={s.vendor_menu_edit_aria}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void deleteMenuItem(item.id)}
                className="p-1.5 text-muted-foreground active:text-danger"
                aria-label={s.vendor_menu_delete_aria}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </SettingsRow>
        ))}

        {addingItem && (
          <div className="px-4 py-3 border-t border-surface-border space-y-2">
            <input
              type="text"
              value={newItem.name}
              onChange={(e) => setNewItem((p) => ({ ...p, name: e.target.value }))}
              placeholder={s.menu_itemName}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                value={newItem.price}
                onChange={(e) => setNewItem((p) => ({ ...p, price: e.target.value }))}
                placeholder={s.menu_price}
                className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <input
                type="text"
                value={newItem.unit}
                onChange={(e) => setNewItem((p) => ({ ...p, unit: e.target.value }))}
                placeholder={s.menu_unit}
                className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
            </div>
            <input
              type="text"
              value={newItem.description}
              onChange={(e) => setNewItem((p) => ({ ...p, description: e.target.value }))}
              placeholder={s.menu_description}
              className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveNewItem()}
                className="flex-1 rounded-lg bg-brand text-page-bg text-sm font-semibold py-2"
              >
                {s.menu_save}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAddingItem(false);
                  setNewItem({ name: "", price: "", unit: "", description: "" });
                }}
                className="flex-1 rounded-lg border border-surface-border text-sm py-2 text-foreground"
              >
                {s.settings_cancel}
              </button>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={() => setAddingItem(true)}
          className="w-full mx-4 mb-3 mt-1 rounded-xl border border-brand/30 bg-brand/5 py-3 text-sm font-semibold text-brand active:scale-[0.99]"
        >
          + {s.menu_addItem}
        </button>
      </SettingsCollapsible>

      <Sheet
        open={editingMenuItem !== null}
        onOpenChange={(open) => {
          if (!open) setEditingMenuItem(null);
        }}
      >
        <SheetContent className="bg-page-bg border-surface-border">
          <SheetHeader>
            <SheetTitle className="text-foreground">{s.menu_itemName}</SheetTitle>
          </SheetHeader>
          {editingMenuItem && (
            <div className="mt-4 space-y-2">
              <input
                type="text"
                value={editDraft.name}
                onChange={(e) => setEditDraft((p) => ({ ...p, name: e.target.value }))}
                placeholder={s.menu_itemName}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  value={editDraft.price}
                  onChange={(e) => setEditDraft((p) => ({ ...p, price: e.target.value }))}
                  placeholder={s.menu_price}
                  className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
                />
                <input
                  type="text"
                  value={editDraft.unit}
                  onChange={(e) => setEditDraft((p) => ({ ...p, unit: e.target.value }))}
                  placeholder={s.menu_unit}
                  className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
                />
              </div>
              <input
                type="text"
                value={editDraft.description}
                onChange={(e) => setEditDraft((p) => ({ ...p, description: e.target.value }))}
                placeholder={s.menu_description}
                className="w-full bg-surface border border-surface-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-brand"
              />
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void saveEditedMenuItem()}
                  className="flex-1 rounded-lg bg-brand text-page-bg text-sm font-semibold py-2"
                >
                  {s.menu_save}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingMenuItem(null)}
                  className="flex-1 rounded-lg border border-surface-border text-sm py-2 text-foreground"
                >
                  {s.settings_cancel}
                </button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <VendorSettingsOffers
        vendorId={vendor.id}
        activeOffer={activeOffer}
        vendorLatitude={vendor.latitude}
        vendorLongitude={vendor.longitude}
        shopName={vendor.shop_name}
        vendorServiceRadiusKm={normalizeServiceRadiusKm(vendor.service_radius_km)}
      />

      {Capacitor.isNativePlatform() && (
        <SettingsCollapsible
          label={s.settings_order_alerts}
          open={orderAlertsOpen}
          onToggle={() => setOrderAlertsOpen((o) => !o)}
          nested
        >
          <VendorSettingsOrderAlertsContent />
        </SettingsCollapsible>
      )}

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
        label={s.cancelReasons}
        open={cancelOpen}
        onToggle={() => setCancelOpen((o) => !o)}
        nested
      >
        <p className="text-xs text-muted-foreground px-4 pt-3 pb-2">{s.cancelReasonsSubtitle}</p>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="px-4 py-2 space-y-1 border-b border-surface-border last:border-0">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {`${s.rejectionReasonField} ${i + 1}`}
            </label>
            <input
              type="text"
              value={cancelReasons[i]}
              onChange={(e) => {
                const next = [...cancelReasons];
                next[i] = e.target.value.slice(0, 60);
                setCancelReasons(next);
                setCancelReasonsChanged(true);
              }}
              maxLength={60}
              className="w-full bg-surface border border-surface-border rounded-xl px-3 py-2.5 text-sm text-foreground focus:outline-none focus:border-brand"
            />
          </div>
        ))}
        <div className="flex justify-end px-4 py-3">
          <button
            type="button"
            onClick={() => void saveCancelReasons()}
            disabled={savingReasons || !cancelReasonsChanged}
            className="text-xs font-semibold text-brand active:opacity-80 disabled:opacity-50"
          >
            {savingReasons ? s.incoming_saving : s.saveReasons}
          </button>
        </div>
      </SettingsCollapsible>

      <SettingsCollapsible
        label={s.vendor_ledgerCycleStart}
        open={ledgerOpen}
        onToggle={() => setLedgerOpen((o) => !o)}
        nested
      >
        <div className="px-4 py-3.5 space-y-2">
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
        <div className="px-4 py-3.5 space-y-3">
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

      <SettingsCollapsible
        label={`⭐ ${s.review_myReviews} (${reviews.length})`}
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
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.settings_loading}</p>
        )}
        {!reviewsLoading && reviews.length === 0 && (
          <p className="text-xs text-muted-foreground px-4 py-3.5">{s.review_noReviews}</p>
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
                  <p className="text-[10px] text-muted-foreground mt-1">
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
                  <p className="text-[10px] font-semibold text-muted-foreground">
                    {s.review_your_reply}
                  </p>
                  <p className="text-xs text-foreground mt-0.5 leading-relaxed">{r.vendor_response}</p>
                  {r.vendor_responded_at && (
                    <p className="text-[10px] text-muted-foreground mt-1">
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
