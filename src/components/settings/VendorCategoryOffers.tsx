import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { supabase, useCategoryLabel } from "@/lib/supabase";
import { useLanguage } from "@/lib/language";
import { cn } from "@/lib/utils";
import { getUserPhone } from "@/lib/userIdentity";
import { withOptionalFeedImageUpload } from "@/lib/imageUpload";
import { FeedImagePicker } from "@/components/settings/FeedImagePicker";
import { captureError } from "@/lib/sentry";
import {
  SettingsSectionLabel,
  SettingsCollapsible,
} from "@/components/settings/SettingsSection";
import {
  type VendorActiveOffer,
  type OfferTargetAudience,
  offerCategoryModeChipLabel,
  offerDateInputMin,
  offerDateToEndIso,
  offerDateToStartIso,
} from "@/components/settings/VendorSettingsShared";
import { normalizeFeedReachKm } from "@/lib/feedReach";

type OfferCategoryRow = {
  id: string;
  label: string;
  emoji: string;
  service_mode: string;
};

export function VendorCategoryOffers({
  vendorId,
  businessCategoryId,
  businessReachKm,
  businessHasLocation,
}: {
  vendorId: string;
  businessCategoryId: string | null;
  businessReachKm: number | null;
  businessHasLocation: boolean;
}) {
  const { s } = useLanguage();
  const getLabel = useCategoryLabel();
  const [activeOffer, setActiveOffer] = useState<VendorActiveOffer | null>(null);
  const [offerText, setOfferText] = useState("");
  const [offerStartsAt, setOfferStartsAt] = useState("");
  const [offerEndsAt, setOfferEndsAt] = useState("");
  const [offerStartError, setOfferStartError] = useState("");
  const [offerEndError, setOfferEndError] = useState("");
  const [offerLoading, setOfferLoading] = useState(false);
  const [offerImageFile, setOfferImageFile] = useState<File | null>(null);
  const [offerImagePreview, setOfferImagePreview] = useState<string | null>(null);
  const [offersOpen, setOffersOpen] = useState(false);
  const [offerAudience, setOfferAudience] = useState<OfferTargetAudience>("customers");
  const [offerTargetCategoryId, setOfferTargetCategoryId] = useState<string | null>(null);
  const [showOfferCategories, setShowOfferCategories] = useState(false);
  const [offerCategories, setOfferCategories] = useState<OfferCategoryRow[]>([]);
  const [offerCategoriesLoading, setOfferCategoriesLoading] = useState(false);

  const needsCategoryPicker = offerAudience === "vendors" || offerAudience === "both";
  const reachLabel = normalizeFeedReachKm(businessReachKm ?? 5);

  const loadActiveOffer = useCallback(async () => {
    if (!businessCategoryId) {
      setActiveOffer(null);
      return;
    }
    const { data, error } = await supabase
      .from("feed_posts")
      .select("id, content, expires_at")
      .eq("vendor_id", vendorId)
      .eq("type", "offer")
      .eq("business_category_id", businessCategoryId)
      .eq("is_hidden", false)
      .gt("expires_at", new Date().toISOString())
      .or("starts_at.is.null,starts_at.lte.now()")
      .maybeSingle();
    if (error) {
      captureError(error, {
        scope: "vendorCategoryOffers.loadActiveOffer",
        vendorId,
        businessCategoryId,
      });
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
  }, [businessCategoryId, vendorId]);

  useEffect(() => {
    void loadActiveOffer();
  }, [loadActiveOffer]);

  useEffect(() => {
    if (!needsCategoryPicker || offerCategories.length > 0 || offerCategoriesLoading) return;
    let cancelled = false;
    setOfferCategoriesLoading(true);
    void supabase
      .from("categories")
      .select("id, label, emoji, service_mode")
      .eq("is_active", true)
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return;
        setOfferCategoriesLoading(false);
        if (error) {
          captureError(error, { scope: "vendorCategoryOffers.loadOfferCategories", vendorId });
          return;
        }
        setOfferCategories((data ?? []) as OfferCategoryRow[]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsCategoryPicker, offerCategories.length, offerCategoriesLoading, vendorId]);

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
    if (!businessCategoryId) return;
    const content = offerText.trim();
    if (!content) return;
    if (!validateOfferDates()) return;
    if (!businessHasLocation) {
      toast.error(s.vendor_offer_location_required);
      return;
    }
    const phone = getUserPhone();
    if (!phone) {
      toast.error(s.vendor_offer_phone_required);
      return;
    }
    setOfferLoading(true);
    let submitResult: { error: unknown | null };
    try {
      submitResult = await withOptionalFeedImageUpload(
        offerImageFile,
        "offers",
        async (imageUrl) => {
          const { error } = await supabase.rpc("vendor_post_offer", {
            p_vendor_id: vendorId,
            p_vendor_phone: phone,
            p_content: content,
            p_starts_at: offerDateToStartIso(offerStartsAt),
            p_expires_at: offerDateToEndIso(offerEndsAt),
            p_image_url: imageUrl,
            p_lat: null,
            p_lng: null,
            p_reach_radius_km: reachLabel,
            p_target_audience: offerAudience,
            p_target_category_id:
              offerAudience === "customers" ? null : offerTargetCategoryId,
            p_business_category_id: businessCategoryId,
          });
          return { error };
        },
      );
    } catch (err) {
      console.error("postOffer upload", err);
      toast.error(s.vendor_offer_image_upload_failed);
      setOfferLoading(false);
      return;
    }
    setOfferLoading(false);
    if (submitResult.error) {
      const message =
        submitResult.error instanceof Error
          ? submitResult.error.message
          : typeof submitResult.error === "object" &&
              submitResult.error !== null &&
              "message" in submitResult.error &&
              typeof (submitResult.error as { message: unknown }).message === "string"
            ? (submitResult.error as { message: string }).message
            : String(submitResult.error);
      toast.error(message);
      return;
    }
    setOfferText("");
    setOfferStartsAt("");
    setOfferEndsAt("");
    setOfferStartError("");
    setOfferEndError("");
    setOfferAudience("customers");
    setOfferTargetCategoryId(null);
    setShowOfferCategories(false);
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
      toast.error(error.message);
      return;
    }
    setActiveOffer(null);
    toast(s.vendor_offer_removed);
  };

  if (!businessCategoryId) return null;

  return (
    <SettingsCollapsible
      label={s.settings_offers}
      open={offersOpen}
      onToggle={() => setOffersOpen((o) => !o)}
      nested
    >
      {activeOffer ? (
        <div className="px-4 py-3 space-y-3">
          <p className="text-sm text-foreground">{activeOffer.content}</p>
          <p className="text-xs text-muted-foreground">
            {s.vendor_offer_expires_label}{" "}
            {activeOffer.expires_at ? new Date(activeOffer.expires_at).toLocaleString() : "—"}
          </p>
          <button
            type="button"
            onClick={() => void removeOffer()}
            disabled={offerLoading}
            className="w-full rounded-xl border border-destructive/40 text-destructive h-10 text-sm font-semibold disabled:opacity-50"
          >
            {s.vendor_offer_remove_btn}
          </button>
        </div>
      ) : (
        <div className="px-4 py-3 space-y-3">
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
          <p className="text-xs text-muted-foreground">
            {s.feed_reachLabel}: {reachLabel} km ({s.my_business_location_label})
          </p>
          <div className="space-y-2">
            <SettingsSectionLabel>{s.vendor_offer_audience_label}</SettingsSectionLabel>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { id: "customers" as const, label: s.vendor_offer_audience_customers },
                  { id: "vendors" as const, label: s.vendor_offer_audience_vendors },
                  { id: "both" as const, label: s.vendor_offer_audience_both },
                ] as const
              ).map((opt) => {
                const selected = offerAudience === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setOfferAudience(opt.id);
                      if (opt.id === "customers") {
                        setOfferTargetCategoryId(null);
                        setShowOfferCategories(false);
                      }
                    }}
                    className={cn(
                      "rounded-xl border px-2 py-2.5 text-xs font-semibold transition-colors active:scale-[0.98]",
                      selected
                        ? "border-brand bg-brand/15 text-brand ring-1 ring-brand/30"
                        : "border-surface-border bg-surface text-muted-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {needsCategoryPicker && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <SettingsSectionLabel>{s.vendor_offer_target_category_label}</SettingsSectionLabel>
                <span className="text-xs text-muted-foreground">
                  {offerTargetCategoryId
                    ? getLabel(
                        offerCategories.find((c) => c.id === offerTargetCategoryId)?.label ?? "",
                      )
                    : s.vendor_offer_target_category_all}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{s.vendor_offer_target_category_hint}</p>
              <button
                type="button"
                onClick={() => setShowOfferCategories((v) => !v)}
                className="text-xs font-medium text-muted-foreground hover:text-foreground underline"
              >
                {s.category_browseManual}
              </button>
              {showOfferCategories && (
                <>
                  {offerCategoriesLoading ? (
                    <p className="mt-2 text-xs text-muted-foreground inline-flex items-center gap-1.5">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      {s.vendor_understanding}
                    </p>
                  ) : offerCategories.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">{s.vendor_categories_pick}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setOfferTargetCategoryId(null)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                          offerTargetCategoryId == null
                            ? "border-primary bg-primary/20 text-foreground ring-1 ring-primary/30"
                            : "border-border bg-card text-foreground",
                        )}
                      >
                        {s.vendor_offer_target_category_all}
                      </button>
                      {offerCategories.map((cat) => {
                        const selected = offerTargetCategoryId === cat.id;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => setOfferTargetCategoryId(cat.id)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                              selected
                                ? "border-primary bg-primary/20 text-foreground ring-1 ring-primary/30"
                                : "border-border bg-card text-foreground",
                            )}
                          >
                            <span>
                              {cat.emoji} {getLabel(cat.label)}
                            </span>
                            <span className="text-xs font-normal text-muted-foreground">
                              {offerCategoryModeChipLabel(cat.service_mode, s)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={() => void postOffer()}
            disabled={offerLoading || offerText.trim().length === 0}
            className="w-full rounded-xl bg-brand text-page-bg h-12 text-sm font-bold disabled:opacity-50 active:scale-[0.99]"
          >
            {s.settings_postOffer}
          </button>
        </div>
      )}
    </SettingsCollapsible>
  );
}
