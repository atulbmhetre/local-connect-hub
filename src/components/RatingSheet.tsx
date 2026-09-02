import { useCallback, useEffect, useRef, useState } from "react";

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
import { ensureVoiceMicrophone } from "@/lib/nativePermissions";

import { toast } from "sonner";
import { SettingsPageHeader, SettingsCard } from "@/components/settings/SettingsSection";
import { cn } from "@/lib/utils";
import { captureError } from "@/lib/sentry";
import { syncVendorRatingFromReviews } from "@/lib/vendorRating";

const RESOLUTION_SESSION_PREFIX = "aaspaas:resolution:";

function radarResolutionAlreadyMarked(vendorId: string): boolean {
  try {
    return sessionStorage.getItem(`${RESOLUTION_SESSION_PREFIX}${vendorId}`) === "1";
  } catch {
    return false;
  }
}

/** Map submit_vendor_review exception codes to localized copy (fallback = generic save error). */
function messageForSubmitReviewError(
  message: string | null | undefined,
  copy: {
    rating_errCouldNotSave: string;
    rating_errRequestNotFound: string;
    rating_errVendorMismatch: string;
    rating_errOrderNotFulfilled: string;
    rating_errNotAuthorized: string;
  },
): string {
  const m = message ?? "";
  if (m.includes("request_not_found")) return copy.rating_errRequestNotFound;
  if (m.includes("vendor_mismatch")) return copy.rating_errVendorMismatch;
  if (m.includes("order_not_fulfilled")) return copy.rating_errOrderNotFulfilled;
  if (m.includes("not_found_or_unauthorized")) return copy.rating_errNotAuthorized;
  return copy.rating_errCouldNotSave;
}

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
  const submitLockRef = useRef(false);

  const [stars, setStars] = useState<number>(0);

  const [reviewText, setReviewText] = useState("");
  const [isListeningReview, setIsListeningReview] = useState(false);



  useEffect(() => {

    if (!isOpen) {

      submitLockRef.current = false;
      setLoading(false);

      setStars(0);

      setReviewText("");
      setIsListeningReview(false);

    }

  }, [isOpen]);



  const mode = serviceMode.trim().toLowerCase();

  const isDelivery = mode === "delivery";
  const isAppointment = mode === "appointment";
  const submitLabel = isDelivery
    ? s.rating_btnDelivered
    : isAppointment
      ? s.rating_btnAppointmentCompleted
      : s.rating_btnHelped;

  const busy = loading !== false;

  const startReviewVoice = async () => {
    if (isListeningReview) return;
    try {
      const available = await SpeechRecognition.available();
      if (!available.available) {
        toast.error(s.rating_voiceUnavailable);
        return;
      }
      const micOk = await ensureVoiceMicrophone();
      if (!micOk) {
        toast.error(s.voice_permissionDenied);
        return;
      }
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
    if (submitLockRef.current) return;
    // Sync lock before React re-render so rapid multi-tap cannot re-enter.
    submitLockRef.current = true;
    setLoading("rate");

    const releaseSubmitLock = () => {
      submitLockRef.current = false;
      setLoading(false);
    };

    const { data: existingReview } = await supabase
      .from("vendor_reviews")
      .select("id")
      .eq("request_id", requestId)
      .maybeSingle();

    if (existingReview) {
      // A review for this order already exists — retrying can never succeed,
      // so dismissing (and archiving via onDismiss) is correct here.
      releaseSubmitLock();
      toast.error(s.rating_errCouldNotSave);
      onDismiss();
      return;
    }

    const deviceId = getDeviceId();
    const userPhone = getUserPhone();
    if (!userPhone) {
      // Failed submission: keep the sheet open (no onDismiss) so the order is
      // NOT marked done and the Rate CTA stays available for retry.
      releaseSubmitLock();
      toast.error(s.feed_phoneRequired);
      return;
    }

    const { error: insertError } = await supabase.rpc("submit_vendor_review", {
      p_vendor_id: vendorId,
      p_request_id: requestId,
      p_user_phone: userPhone,
      p_device_id: deviceId,
      p_rating: stars,
      p_review_text: reviewText.trim() || null,
      p_service_mode: serviceMode,
    });

    if (insertError) {
      // Failed submission: the rating did NOT save. Do not fire onDismiss —
      // MyOrders would markDone/archive the order and lose the Rate CTA.
      captureError(insertError, {
        scope: "ratingSheet.submitVendorReview",
        vendorId,
        requestId,
      });
      releaseSubmitLock();
      toast.error(messageForSubmitReviewError(insertError.message, s));
      return;
    }

    if (!radarResolutionAlreadyMarked(vendorId)) {
      const rpc = isDelivery ? "increment_vendor_delivered" : "increment_vendor_helped";
      const { error: rpcError } = await supabase.rpc(rpc, { p_vendor_id: vendorId });

      if (rpcError) {
        // The review itself saved; only the served-counter increment failed.
        // A retry would hit the duplicate-review guard, so dismissing is fine —
        // log the counter drift for investigation.
        captureError(rpcError, {
          scope: `ratingSheet.${rpc}`,
          vendorId,
          requestId,
        });
        releaseSubmitLock();
        toast.error(s.rating_errCouldNotSave);
        onDismiss();
        return;
      }
    }

    await syncVendorRatingFromReviews(vendorId, {
      shopName,
      alertAdmin: true,
    });

    if (stars <= 2) {
      void invokeNotifyVendor({
        vendor_id: vendorId,
        notification_title: s.review_lowRatingNotifTitle,
        message: s.review_lowRatingNotifBody,
        request_id: requestId,
        type: "review_received",
        route: "settings",
        route_params: {
          vendor_id: vendorId,
          open_reviews: "1",
        },
      });
    }

    releaseSubmitLock();
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

    const { data: existingReview } = await supabase
      .from("vendor_reviews")
      .select("id")
      .eq("request_id", requestId)
      .maybeSingle();

    if (!existingReview && !radarResolutionAlreadyMarked(vendorId)) {
      const { error } = await supabase.rpc("increment_vendor_issues", { p_vendor_id: vendorId });
      if (error) {
        // Failed submission: keep the sheet open so the user can retry the
        // issue report; do not archive the order via onDismiss.
        captureError(error, {
          scope: "ratingSheet.incrementVendorIssues",
          vendorId,
          requestId,
        });
        setLoading(false);
        toast.error(s.rating_errCouldNotSaveFeedback);
        return;
      }
    }

    setLoading(false);
    onDismiss();
  }, [vendorId, requestId, onDismiss, s.rating_errCouldNotSaveFeedback]);



  return (

    <Sheet

      open={isOpen}

      onOpenChange={(open) => {
        if (!open && !busy) onDismiss();
      }}

    >

      <SheetContent
        data-testid="rating-sheet"
        side="bottom"
        className="bg-page-bg border-t border-surface-border rounded-t-2xl max-h-[85vh] overflow-y-auto px-4"
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
            className="w-full rounded-2xl bg-brand text-white h-12 font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"
          >
            {loading === "rate" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}
            {submitLabel}
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
          <p className="text-xs text-muted-foreground text-center pt-1">
            {s.rating_helperText}
          </p>

        </div>
        </div>
      </SheetContent>

    </Sheet>

  );

}


