import { supabase } from "@/lib/supabase";
import { captureError } from "@/lib/sentry";

/** Vendor Settings → reply to a customer review. */
export async function sendVendorReviewReply(opts: {
  vendorId: string;
  vendorPhone: string;
  reviewId: string;
  response: string;
}): Promise<{ ok: true; respondedAt: string } | { ok: false; error: { message: string } }> {
  const respondedAt = new Date().toISOString();
  const { error } = await supabase.rpc("vendor_reply_to_review", {
    p_vendor_id: opts.vendorId,
    p_vendor_phone: opts.vendorPhone,
    p_review_id: opts.reviewId,
    p_response: opts.response,
  });
  if (error) {
    captureError(error, {
      scope: "vendorSettings.replyToReview",
      vendorId: opts.vendorId,
      reviewId: opts.reviewId,
    });
    return { ok: false, error };
  }
  return { ok: true, respondedAt };
}
