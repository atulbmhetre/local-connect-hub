import { useCallback, useEffect, useState } from "react";
import { VendorNoteEditor } from "@/components/vendor/VendorNoteEditor";
import { Bell, Pencil, Trash2, Mic, Camera, Loader2 } from "lucide-react";
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
import { useAppConfig } from "@/hooks/useAppConfig";
import { Switch } from "@/components/ui/switch";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
  SettingsCollapsible,
  SettingsParentCollapsible,
  type SettingsActiveGroup,
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
import {
  generateUserReferralCode,
  referralCodeFromPhone,
} from "@/lib/referral";
import { getUserPhone } from "@/lib/userIdentity";
import { uploadFeedImage } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { useFeedNotificationsEnabled } from "@/hooks/useFeedNotificationsEnabled";

type MenuItem = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  unit: string | null;
  is_available: boolean;
  sort_order: number;
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
  activeGroup: SettingsActiveGroup;
  onActiveGroupChange: (group: SettingsActiveGroup) => void;
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

export function VendorSettingsOffers({ vendorId }: { vendorId: string }) {
  const [activeOffer, setActiveOffer] = useState<{
    id: string;
    content: string;
    expires_at: string | null;
  } | null>(null);
  const [offerText, setOfferText] = useState("");
  const [offerStartsAt, setOfferStartsAt] = useState("");
  const [offerEndsAt, setOfferEndsAt] = useState("");
  const [offerStartError, setOfferStartError] = useState("");
  const [offerEndError, setOfferEndError] = useState("");
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerImageFile, setOfferImageFile] = useState<File | null>(null);
  const [offerImagePreview, setOfferImagePreview] = useState<string | null>(null);
  const [offersOpen, setOffersOpen] = useState(false);

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

  useEffect(() => {
    void loadActiveOffer();
  }, [loadActiveOffer]);

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
      setOfferStartError("Please set offer start date");
      ok = false;
    } else {
      setOfferStartError("");
    }

    if (!offerEndsAt || (offerStartsAt && offerEndsAt <= offerStartsAt)) {
      setOfferEndError("Please set offer end date");
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
      toast.error("Add your phone in Settings first");
      return;
    }
    setOfferLoading(true);
    let imageUrl: string | null = null;
    if (offerImageFile) {
      try {
        imageUrl = await uploadFeedImage(offerImageFile, "offers");
      } catch (err) {
        console.error("postOffer upload", err);
        toast.error("Image upload failed");
        setOfferLoading(false);
        return;
      }
    }
    const { error } = await supabase.from("feed_posts").insert({
      type: "offer",
      vendor_id: vendorId,
      user_phone: phone,
      content,
      is_hidden: false,
      starts_at: offerDateToStartIso(offerStartsAt),
      expires_at: offerDateToEndIso(offerEndsAt),
      image_url: imageUrl,
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
    toast("Offer posted!");
  };

  const removeOffer = async () => {
    if (!activeOffer) return;
    setOfferLoading(true);
    const { error } = await supabase
      .from("feed_posts")
      .update({ is_hidden: true })
      .eq("id", activeOffer.id);
    setOfferLoading(false);
    if (error) {
      console.error("removeOffer", error);
      toast.error(error.message);
      return;
    }
    setActiveOffer(null);
    toast("Offer removed");
  };

  return (
    <SettingsCollapsible
      label="Offers"
      open={offersOpen}
      onToggle={() => setOffersOpen((o) => !o)}
      nested
    >
      {activeOffer ? (
          <div className="px-4 py-3.5 space-y-3">
            <p className="text-sm text-foreground">{activeOffer.content}</p>
            <p className="text-xs text-muted-foreground">
              Expires:{" "}
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
              Remove
            </button>
          </div>
        ) : (
          <div className="px-4 py-3.5 space-y-3">
            <input
              type="text"
              maxLength={100}
              value={offerText}
              onChange={(e) => setOfferText(e.target.value)}
              placeholder="e.g. 20% off groceries today"
              className="w-full rounded-xl border border-surface-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:border-brand"
            />
            <FeedImagePicker
              label="Add photo (optional)"
              previewUrl={offerImagePreview}
              onPick={onOfferImagePick}
            />
            <div>
              <label
                htmlFor="vendor-offer-starts"
                className="block text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5"
              >
                Offer starts
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
                Offer ends
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
            <button
              type="button"
              onClick={() => void postOffer()}
              disabled={offerLoading || offerText.trim().length === 0}
              className="w-full rounded-xl bg-brand text-page-bg py-3 text-sm font-bold disabled:opacity-50 active:scale-[0.99]"
            >
              Post Offer
            </button>
          </div>
        )}
    </SettingsCollapsible>
  );
}

export function VendorSettingsNotifications({ vendor: _vendor }: { vendor: Vendor }) {
  const { s } = useLanguage();
  const [vendorVibrate, setVendorVibrate] = useState(() => isVendorVibrateEnabled());
  const [vendorSound, setVendorSound] = useState(() => isVendorSoundEnabled());
  const { enabled: feedNotificationsEnabled, onCheckedChange: onFeedNotificationsChange } =
    useFeedNotificationsEnabled();
  const native = Capacitor.isNativePlatform();

  if (!native) return null;

  return (
    <section className="mx-4 rounded-2xl border border-surface-border bg-surface overflow-hidden mb-3">
      <div className="px-4 py-3 border-b border-surface-border">
        <p className="text-sm font-medium text-foreground">{s.settings_notifications}</p>
      </div>
      <div>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{s.settings_vibrate}</p>
          </div>
          <Switch
            checked={vendorVibrate}
            onCheckedChange={(checked) => {
              setVendorVibrate(checked);
              setVendorVibrateEnabled(checked);
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 border-b border-surface-border">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{s.settings_sound}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{s.settings_sound_body}</p>
          </div>
          <Switch
            checked={vendorSound}
            onCheckedChange={(checked) => {
              setVendorSound(checked);
              setVendorSoundEnabled(checked);
            }}
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{s.settings_feedNotifications}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {s.settings_feedNotificationsHint}
            </p>
          </div>
          <Switch
            checked={feedNotificationsEnabled}
            onCheckedChange={onFeedNotificationsChange}
          />
        </div>
      </div>
    </section>
  );
}

export function VendorSettingsReferEarn({
  vendor,
  userPhone,
}: {
  vendor?: Vendor | null;
  userPhone?: string | null;
}) {
  const { s } = useLanguage();
  const { config } = useAppConfig();
  const initialVendorCode = vendor?.referral_code?.trim() || null;
  const [referralCode, setReferralCode] = useState<string | null>(initialVendorCode);
  const [referralLoading, setReferralLoading] = useState(!initialVendorCode);
  const [creditTotal, setCreditTotal] = useState(0);
  const [creditPending, setCreditPending] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const resolveFallback = (): string => {
      const phone = (vendor?.phone ?? userPhone ?? "").trim();
      if (vendor?.id) return referralCodeFromPhone(phone);
      return generateUserReferralCode(phone || undefined);
    };

    const loadReferral = async () => {
      setReferralLoading(true);
      setCreditTotal(0);
      setCreditPending(0);
      try {
        const storedVendorId =
          typeof localStorage !== "undefined"
            ? localStorage.getItem("aaspaas:vendor_id")?.trim() || null
            : null;
        const vendorIdForCredits = vendor?.id ?? storedVendorId;

        if (vendor?.id) {
          const { data } = await supabase
            .from("vendors")
            .select("referral_code")
            .eq("id", vendor.id)
            .maybeSingle();
          if (cancelled) return;
          const fromDb = data?.referral_code?.trim() || null;
          setReferralCode(fromDb ?? vendor?.referral_code?.trim() ?? resolveFallback());

          if (vendorIdForCredits) {
            const { data: credits } = await supabase
              .from("vendor_credits")
              .select("amount, disbursed")
              .eq("vendor_id", vendorIdForCredits);
            if (!cancelled && credits?.length) {
              let total = 0;
              let pending = 0;
              for (const row of credits) {
                const amt = Number(row.amount) || 0;
                total += amt;
                if (!row.disbursed) pending += amt;
              }
              setCreditTotal(total);
              setCreditPending(pending);
            }
          }
          return;
        }

        const phone = (userPhone ?? "").trim();
        if (phone) {
          const { data } = await supabase
            .from("app_users")
            .select("referral_code")
            .eq("phone", phone)
            .maybeSingle();
          if (cancelled) return;
          const fromDb = data?.referral_code?.trim() || null;
          setReferralCode(fromDb ?? resolveFallback());
          return;
        }

        if (!cancelled) setReferralCode(resolveFallback());
      } catch {
        if (!cancelled) setReferralCode(resolveFallback());
      } finally {
        if (!cancelled) setReferralLoading(false);
      }
    };

    void loadReferral();
    return () => {
      cancelled = true;
    };
  }, [vendor?.id, vendor?.phone, vendor?.referral_code, userPhone]);

  const referLink =
    referralCode != null ? `${config.appBaseUrl}/r/${referralCode}` : null;

  const copyReferralCode = async () => {
    if (!referralCode) return;
    try {
      await navigator.clipboard.writeText(referralCode);
      toast.success(s.vendor_referCodeCopied);
    } catch {
      toast.error("Could not copy");
    }
  };

  const shareReferLink = async () => {
    if (!referLink) return;
    const message = vendor?.shop_name
      ? `Order from ${vendor.shop_name} on Aaspaas! ${referLink}`
      : `Get help around you, now! Download Aaspaas: ${referLink}`;
    if (navigator.share) {
      try {
        await navigator.share({ text: message });
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
      {referralLoading ? (
        <p className="text-sm text-muted-foreground px-4 py-3.5">{s.settings_loading}</p>
      ) : referralCode != null ? (
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
  activeGroup,
  onActiveGroupChange,
}: Props) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const getMode = useServiceModeLabel();

  const [cancelReasons, setCancelReasons] = useState(["", "", "", ""]);
  const [cancelReasonsChanged, setCancelReasonsChanged] = useState(false);
  const [savingReasons, setSavingReasons] = useState(false);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
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
  const [shopOpen, setShopOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [callReview, setCallReview] = useState<{
    callerPhone: string;
    serviceMode: string;
  } | null>(null);
  const [ledgerCycleStart, setLedgerCycleStart] = useState(() =>
    ledgerCycleStartInputValue(vendor.ledger_cycle_start),
  );
  const [savingLedgerCycleStart, setSavingLedgerCycleStart] = useState(false);

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
    const { error } = await supabase
      .from("vendor_reviews")
      .update({
        vendor_response: text,
        vendor_responded_at: respondedAt,
      })
      .eq("id", reviewId);
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
    void loadMenu();
  }, [loadMenu]);

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

  const saveLedgerCycleStart = async (date: string) => {
    if (!date || savingLedgerCycleStart) return;
    setSavingLedgerCycleStart(true);
    const { error } = await supabase
      .from("vendors")
      .update({ ledger_cycle_start: date })
      .eq("id", vendor.id);
    setSavingLedgerCycleStart(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onVendorUpdated({ ...vendor, ledger_cycle_start: date });
    toast.success("Ledger cycle start updated.");
  };

  const saveCancelReasons = async () => {
    setSavingReasons(true);
    const updates = {
      cancel_reason_1: cancelReasons[0].trim() || null,
      cancel_reason_2: cancelReasons[1].trim() || null,
      cancel_reason_3: cancelReasons[2].trim() || null,
      cancel_reason_4: cancelReasons[3].trim() || null,
    };
    const { error } = await supabase.from("vendors").update(updates).eq("id", vendor.id);
    setSavingReasons(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    onVendorUpdated({ ...vendor, ...updates });
    setCancelReasonsChanged(false);
    toast.success("Saved");
  };

  const saveNewItem = async () => {
    if (!newItem.name.trim() || !newItem.price) return;
    await supabase.from("vendor_menu_items").insert({
      vendor_id: vendor.id,
      name: newItem.name.trim(),
      price: parseFloat(newItem.price),
      unit: newItem.unit.trim() || null,
      description: newItem.description.trim() || null,
      sort_order: menuItems.length,
    });
    setNewItem({ name: "", price: "", unit: "", description: "" });
    setAddingItem(false);
    void loadMenu();
  };

  const saveEditedMenuItem = async () => {
    if (!editingMenuItem || !editDraft.name.trim() || !editDraft.price) return;
    await supabase
      .from("vendor_menu_items")
      .update({
        name: editDraft.name.trim(),
        price: parseFloat(editDraft.price),
        unit: editDraft.unit.trim() || null,
        description: editDraft.description.trim() || null,
      })
      .eq("id", editingMenuItem.id);
    setEditingMenuItem(null);
    void loadMenu();
  };

  const toggleAvailability = async (item: MenuItem) => {
    await supabase
      .from("vendor_menu_items")
      .update({ is_available: !item.is_available })
      .eq("id", item.id);
    void loadMenu();
  };

  const deleteMenuItem = async (id: string) => {
    await supabase.from("vendor_menu_items").delete().eq("id", id);
    void loadMenu();
  };

  const startVoiceMenu = async () => {
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error("Voice not available");
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
      if (result.success && result.items?.length) {
        await supabase.from("vendor_menu_items").insert(
          result.items.map(
            (
              item: { description?: string; unit_price?: number; unit?: string },
              idx: number,
            ) => ({
              vendor_id: vendor.id,
              name: item.description ?? "",
              price: item.unit_price ?? 0,
              unit: item.unit || null,
              sort_order: menuItems.length + idx,
            }),
          ),
        );
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
        if (result.success && result.items?.length) {
          await supabase.from("vendor_menu_items").insert(
            result.items.map(
              (
                item: { description?: string; unit_price?: number; unit?: string },
                idx: number,
              ) => ({
                vendor_id: vendor.id,
                name: item.description ?? "",
                price: item.unit_price ?? 0,
                unit: item.unit || null,
                sort_order: menuItems.length + idx,
              }),
            ),
          );
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
    <SettingsParentCollapsible
      label="MY SHOP"
      open={activeGroup === "shop"}
      onToggle={() => onActiveGroupChange("shop")}
    >
      <SettingsCollapsible
        label="Shop Info"
        open={shopOpen}
        onToggle={() => setShopOpen((o) => !o)}
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
        {onEditShopDetails && (
          <button
            type="button"
            onClick={onEditShopDetails}
            className="w-full px-4 py-3.5 border-t border-surface-border text-sm font-semibold text-brand text-center active:opacity-90"
          >
            ✏️ Edit Shop Details
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
                  Listening... speak now
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
                aria-label="Edit item"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void deleteMenuItem(item.id)}
                className="p-1.5 text-muted-foreground active:text-danger"
                aria-label="Delete item"
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

      <VendorSettingsOffers vendorId={vendor.id} />

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
                    📞 Call customer
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
  );
}
