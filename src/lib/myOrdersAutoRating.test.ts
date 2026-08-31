import { describe, expect, it } from "vitest";
import {
  isMyOrdersOverlayBlockingAutoRating,
  resolveAutoRatingAction,
  shouldDeferAutoRatingForUnpaidPayNow,
} from "@/lib/myOrdersAutoRating";

describe("isMyOrdersOverlayBlockingAutoRating", () => {
  it("returns false when no overlay is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({})).toBe(false);
  });

  it("blocks when payment sheet is loading", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ paymentSheetLoading: true })).toBe(true);
  });

  it("blocks when payment sheet is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ paymentSheetOpen: true })).toBe(true);
  });

  it("blocks when khata detail sheet is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ khataDetailOpen: true })).toBe(true);
  });

  it("blocks when any listed overlay is open", () => {
    expect(
      isMyOrdersOverlayBlockingAutoRating({
        editOrderOpen: true,
        billHistoryOpen: false,
      }),
    ).toBe(true);
  });
});

describe("shouldDeferAutoRatingForUnpaidPayNow", () => {
  it("defers while Pay Now is on screen and payment has not been opened", () => {
    expect(
      shouldDeferAutoRatingForUnpaidPayNow({
        unpaidCashOrUpiBill: true,
        customerOpenedPayment: false,
      }),
    ).toBe(true);
  });

  it("does not defer after the customer opens the payment flow", () => {
    expect(
      shouldDeferAutoRatingForUnpaidPayNow({
        unpaidCashOrUpiBill: true,
        customerOpenedPayment: true,
      }),
    ).toBe(false);
  });

  it("does not defer when there is no unpaid cash/UPI bill", () => {
    expect(
      shouldDeferAutoRatingForUnpaidPayNow({
        unpaidCashOrUpiBill: false,
        customerOpenedPayment: false,
      }),
    ).toBe(false);
  });
});

describe("resolveAutoRatingAction", () => {
  const base = {
    alreadyShown: false,
    alreadyReviewed: false,
    ratingSheetAlreadyOpenForOrder: false,
    overlayBlocking: false,
    deferForUnpaidPayNow: false,
  };

  it("opens when nothing blocks", () => {
    expect(resolveAutoRatingAction(base)).toBe("open");
  });

  it("skips when already shown or reviewed", () => {
    expect(resolveAutoRatingAction({ ...base, alreadyShown: true })).toBe("skip");
    expect(resolveAutoRatingAction({ ...base, alreadyReviewed: true })).toBe("skip");
  });

  it("skips when the sheet is already open for this order — do not stash for retry", () => {
    expect(
      resolveAutoRatingAction({
        ...base,
        overlayBlocking: true,
        deferForUnpaidPayNow: true,
        ratingSheetAlreadyOpenForOrder: true,
      }),
    ).toBe("skip");
  });

  it("skips already-shown even when unpaid Pay Now would otherwise defer", () => {
    expect(
      resolveAutoRatingAction({
        ...base,
        alreadyShown: true,
        deferForUnpaidPayNow: true,
      }),
    ).toBe("skip");
  });

  it("defers for overlay or unpaid Pay Now without stashing as shown", () => {
    expect(resolveAutoRatingAction({ ...base, overlayBlocking: true })).toBe("defer");
    expect(resolveAutoRatingAction({ ...base, deferForUnpaidPayNow: true })).toBe("defer");
  });
});
