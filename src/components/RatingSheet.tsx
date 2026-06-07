import { useCallback, useEffect, useState } from "react";

import {
  Sheet,

  SheetContent,

  SheetDescription,

  SheetHeader,

  SheetTitle,

} from "@/components/ui/sheet";

import { supabase, invokeNotifyVendor } from "@/lib/supabase";

import { useLanguage } from "@/lib/language";

import { getDeviceId } from "@/lib/deviceId";

import { getUserPhone } from "@/lib/userIdentity";

import { Loader2, Mic, Square } from "lucide-react";

import { Capacitor } from "@capacitor/core";

import { SpeechRecognition } from "@capacitor-community/speech-recognition";
import { getVoiceLang } from "@/lib/voiceUtils";

import { toast } from "sonner";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import { cn } from "@/lib/utils";
import { saveNotification } from "@/lib/notifications";
import { syncVendorRatingFromReviews } from "@/lib/vendorRating";

// DB migration (run if not applied): ALTER TABLE vendors ADD COLUMN IF NOT EXISTS low_rating_admin_notified boolean DEFAULT false;



type Props = {

  isOpen: boolean;

  shopName: string;

  serviceMode: string;

  vendorId: string;

  vendorPhone?: string | null;

  requestId: string;

  onDismiss: () => void;

};



export function RatingSheet({

  isOpen,

  shopName,

  serviceMode,

  vendorId,

  vendorPhone,

  requestId,

  onDismiss,

}: Props) {

  const { s, lang } = useLanguage();

  const [loading, setLoading] = useState<false | "rate" | "issue">(false);

  const [stars, setStars] = useState<number>(0);

  const [reviewText, setReviewText] = useState("");
  const [isListeningReview, setIsListeningReview] = useState(false);



  useEffect(() => {

    if (!isOpen) {

      setLoading(false);

      setStars(0);

      setReviewText("");
      setIsListeningReview(false);

    }

  }, [isOpen]);



  const mode = serviceMode.trim().toLowerCase();

  const isDelivery = mode === "delivery";

  const busy = loading !== false;

  const startReviewVoice = async () => {
    if (isListeningReview) return;
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error("Voice not available on this device");
        return;
      }
      await SpeechRecognition.requestPermissions();
      setIsListeningReview(true);
      const result = await SpeechRecognition.start({
        language: getVoiceLang(),
        maxResults: 1,
        popup: false,
        partialResults: false,
      });
      if (result?.matches?.length > 0) {
        const text = result.matches[0]?.trim();
        if (text) {
          setReviewText((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
        }
      }
    } catch {
      // user cancelled or denied — silent
    } finally {
      setIsListeningReview(false);
    }
  };



  const handleRate = useCallback(async () => {

    setLoading("rate");

    const rpc = isDelivery ? "increment_vendor_delivered" : "increment_vendor_helped";

    const { error } = await supabase.rpc(rpc, { p_vendor_id: vendorId });

    if (!error && stars > 0) {

      const deviceId = getDeviceId();

      const userPhone = getUserPhone();

      await supabase.from("vendor_reviews").insert({

        vendor_id: vendorId,

        request_id: requestId,

        user_phone: userPhone,

        device_id: deviceId,

        rating: stars,

        review_text: reviewText.trim() || null,

        service_mode: serviceMode,

      });

      await syncVendorRatingFromReviews(vendorId, {
        shopName,
        alertAdmin: true,
      });

      if (stars <= 2) {
        void invokeNotifyVendor({
          vendor_id: vendorId,
          notification_title: s.review_lowRatingNotifTitle,
          message: s.review_lowRatingNotifBody,
        });
        const phone = vendorPhone?.trim();
        if (phone) {
          saveNotification({
            userPhone: phone,
            type: "order_update",
            title: s.review_lowRatingNotifTitle,
            body: s.review_lowRatingNotifBody,
            route: "vendor",
            routeParams: { order_id: requestId },
            isInformational: false,
          });
        }
      }

    }

    setLoading(false);

    if (error) {

      toast.error(s.rating_errCouldNotSave);

    }

    onDismiss();

  }, [

    isDelivery,

    vendorId,

    requestId,

    stars,

    reviewText,

    serviceMode,

    onDismiss,

    s.rating_errCouldNotSave,
    s.review_lowRatingNotifTitle,
    s.review_lowRatingNotifBody,
    shopName,
    vendorPhone,

  ]);



  const handleIssue = useCallback(async () => {

    setLoading("issue");

    const { error } = await supabase.rpc("increment_vendor_issues", { p_vendor_id: vendorId });

    setLoading(false);

    if (error) {

      toast.error(s.rating_errCouldNotSaveFeedback);

    }

    onDismiss();

  }, [vendorId, onDismiss, s.rating_errCouldNotSaveFeedback]);



  return (

    <Sheet

      open={isOpen}

      onOpenChange={(open) => {

        if (!open && !busy) return;

      }}

    >

      <SheetContent
        data-testid="rating-sheet"
        side="bottom"
        className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[85vh] overflow-y-auto"
        style={{ transform: "translateZ(0)", WebkitOverflowScrolling: "touch" }}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{s.rating_heading}</SheetTitle>
          <SheetDescription>{shopName}</SheetDescription>
        </SheetHeader>

        <div className="px-4 pt-2">
          <SettingsPageHeader title={s.review_rateExperience} subtitle={shopName} />

        <div className="flex flex-col gap-3">

          <div className="flex gap-2 justify-center py-4">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  data-testid={`rating-star-${n}`}
                  onClick={() => setStars(n)}
                  className={cn(
                    "text-4xl transition-transform active:scale-110",
                    n <= stars ? "opacity-100" : "opacity-30",
                  )}
                >
                  ⭐
                </button>
              ))}
          </div>

          {stars > 0 && (
            <div className="mx-0">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1.5 block">
                {s.review_placeholder}
              </label>
            <SettingsCard className="mx-0 mb-0 relative">
              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value.slice(0, 200))}
                rows={3}
                placeholder={s.review_placeholder}
                className="w-full bg-transparent border-0 rounded-xl px-3 py-3 pr-12 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none resize-none"
              />
              {Capacitor.isNativePlatform() && (
                <button
                  type="button"
                  onClick={() => void startReviewVoice()}
                  className={cn(
                    "absolute right-3 bottom-3 p-1.5 rounded-lg border transition-colors",
                    isListeningReview
                      ? "border-danger bg-danger/10 text-danger animate-pulse"
                      : "border-surface-border bg-surface text-muted-foreground active:text-brand",
                  )}
                >
                  {isListeningReview ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </SettingsCard>
            </div>
          )}

          <button
            type="button"
            data-testid="rating-submit-btn"
            disabled={busy || stars === 0}
            onClick={() => void handleRate()}
            className="w-full rounded-2xl bg-brand text-white py-4 font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
          >
            {loading === "rate" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}
            {isDelivery ? s.rating_btnDelivered : s.rating_btnHelped}
          </button>
          <button
            type="button"
            data-testid="rating-skip-btn"
            disabled={busy}
            onClick={() => onDismiss()}
            className="w-full text-xs text-muted-foreground text-center py-1 active:opacity-80 disabled:opacity-60"
          >
            {s.rating_skip}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleIssue()}
            className="w-full text-sm text-muted-foreground text-center py-2 active:opacity-80 disabled:opacity-60"
          >
            {loading === "issue" ? <Loader2 className="h-4 w-4 animate-spin inline shrink-0" /> : null}{" "}
            {s.rating_btnIssue}
          </button>
          <p className="text-[11px] text-muted-foreground text-center pt-1">
            {s.rating_helperText}
          </p>

        </div>
        </div>
      </SheetContent>

    </Sheet>

  );

}


