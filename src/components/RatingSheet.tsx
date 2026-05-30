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

import { toast } from "sonner";



type Props = {

  isOpen: boolean;

  shopName: string;

  serviceMode: string;

  vendorId: string;

  requestId: string;

  onDismiss: () => void;

};



export function RatingSheet({

  isOpen,

  shopName,

  serviceMode,

  vendorId,

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
      await (
        SpeechRecognition as unknown as {
          requestPermission: () => Promise<{ speechRecognition: string }>;
        }
      ).requestPermission();
      setIsListeningReview(true);
      const result = await SpeechRecognition.start({
        language: "en-IN",
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

      const { data: reviews } = await supabase

        .from("vendor_reviews")

        .select("rating")

        .eq("vendor_id", vendorId);

      if (reviews?.length) {

        const avg = reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length;

        await supabase

          .from("vendors")

          .update({

            avg_rating: Math.round(avg * 10) / 10,

            review_count: reviews.length,

          })

          .eq("id", vendorId);

      }

      if (stars <= 2) {
        void invokeNotifyVendor({
          vendor_id: vendorId,
          notification_title: s.review_lowRatingNotifTitle,
          message: s.review_lowRatingNotifBody,
        });
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

        side="bottom"

        className="bg-page-bg border-t border-surface-raised text-white rounded-t-2xl max-h-[85vh] overflow-y-auto"

      >

        <SheetHeader className="text-left space-y-1 pr-8">

          <SheetTitle className="text-white font-display">{s.rating_heading}</SheetTitle>

          <SheetDescription className="text-gray-400">{shopName}</SheetDescription>

        </SheetHeader>



        <div className="mt-6 flex flex-col gap-2">

          <div className="space-y-2">

            <p className="text-xs text-muted-foreground">{s.review_rateExperience}</p>

            <div className="flex gap-2 justify-center">

              {[1, 2, 3, 4, 5].map((n) => (

                <button

                  key={n}

                  type="button"

                  onClick={() => setStars(n)}

                  className={`text-2xl transition-transform active:scale-110 ${

                    n <= stars ? "opacity-100" : "opacity-30"

                  }`}

                >

                  ⭐

                </button>

              ))}

            </div>

          </div>



          {stars > 0 && (
            <div className="relative">
              <textarea
                value={reviewText}
                onChange={(e) => setReviewText(e.target.value.slice(0, 200))}
                rows={2}
                placeholder={s.review_placeholder}
                className="w-full bg-surface border border-surface-border rounded-xl px-3 py-2 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand resize-none"
              />
              {Capacitor.isNativePlatform() && (
                <button
                  type="button"
                  onClick={() => void startReviewVoice()}
                  className={`absolute right-2 bottom-2 p-1.5 rounded-lg border transition-colors ${
                    isListeningReview
                      ? "border-danger bg-danger/10 text-danger animate-pulse"
                      : "border-surface-border bg-surface text-gray-400 hover:text-brand"
                  }`}
                >
                  {isListeningReview ? (
                    <Square className="h-3.5 w-3.5" />
                  ) : (
                    <Mic className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          )}



          <button

            type="button"

            disabled={busy || stars === 0}

            onClick={() => void handleRate()}

            className="w-full rounded-xl bg-brand text-page-bg py-3.5 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-50"

          >

            {loading === "rate" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}

            {isDelivery ? s.rating_btnDelivered : s.rating_btnHelped}

          </button>

          <button

            type="button"

            disabled={busy}

            onClick={() => void handleIssue()}

            className="w-full rounded-xl border border-destructive/50 text-destructive bg-transparent py-3 font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform disabled:opacity-60"

          >

            {loading === "issue" ? <Loader2 className="h-5 w-5 animate-spin shrink-0" /> : null}

            {s.rating_btnIssue}

          </button>

          <p className="text-[11px] text-gray-500 text-center pt-1">

            {s.rating_helperText}

          </p>

        </div>

      </SheetContent>

    </Sheet>

  );

}


