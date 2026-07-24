import { describe, expect, it, vi, beforeEach } from "vitest";
import { sendVendorReviewReply } from "@/lib/vendorReviewReply";

const { captureError, rpcMock } = vi.hoisted(() => ({
  captureError: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

describe("sendVendorReviewReply captureError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forces vendor_reply_to_review failure → captureError vendorSettings.replyToReview", async () => {
    const err = { message: "forced_reply_fail" };
    rpcMock.mockResolvedValue({ data: null, error: err });

    const result = await sendVendorReviewReply({
      vendorId: "vendor-reply-1",
      vendorPhone: "9876500099",
      reviewId: "review-1",
      response: "Sorry about the delay",
    });

    expect(result).toEqual({ ok: false, error: err });
    expect(rpcMock).toHaveBeenCalledWith(
      "vendor_reply_to_review",
      expect.objectContaining({
        p_vendor_id: "vendor-reply-1",
        p_review_id: "review-1",
      }),
    );
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        scope: "vendorSettings.replyToReview",
        vendorId: "vendor-reply-1",
        reviewId: "review-1",
      }),
    );
  });
});
