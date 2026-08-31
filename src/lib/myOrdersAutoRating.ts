/** Sheet/modal state on My Orders that must block auto-rating from stacking on top. */
export type MyOrdersOverlayState = {
  ratingSheetOpen?: boolean;
  paymentSheetOpen?: boolean;
  paymentSheetLoading?: boolean;
  khataDetailOpen?: boolean;
  editOrderOpen?: boolean;
  editingReviewOpen?: boolean;
  aiSheetOpen?: boolean;
  helpCallSheetOpen?: boolean;
  billHistoryOpen?: boolean;
};

export function isMyOrdersOverlayBlockingAutoRating(
  state: MyOrdersOverlayState,
): boolean {
  return !!(
    state.ratingSheetOpen ||
    state.paymentSheetOpen ||
    state.paymentSheetLoading ||
    state.khataDetailOpen ||
    state.editOrderOpen ||
    state.editingReviewOpen ||
    state.aiSheetOpen ||
    state.helpCallSheetOpen ||
    state.billHistoryOpen
  );
}

/**
 * Unpaid cash/UPI (Pay Now on the card) must not auto-open rating until the
 * customer has opened payment, or the bill is no longer unpaid.
 */
export function shouldDeferAutoRatingForUnpaidPayNow(opts: {
  unpaidCashOrUpiBill: boolean;
  customerOpenedPayment: boolean;
}): boolean {
  return opts.unpaidCashOrUpiBill && !opts.customerOpenedPayment;
}

export type AutoRatingAction = "open" | "defer" | "skip";

/**
 * Decide whether to open, stash, or drop an auto-rating attempt.
 * skip = already shown/reviewed, or the sheet is already open for this order
 *        (do not stash — that re-opens after Issue/Skip).
 */
export function resolveAutoRatingAction(opts: {
  alreadyShown: boolean;
  alreadyReviewed: boolean;
  ratingSheetAlreadyOpenForOrder: boolean;
  overlayBlocking: boolean;
  deferForUnpaidPayNow: boolean;
}): AutoRatingAction {
  if (opts.alreadyShown || opts.alreadyReviewed) return "skip";
  if (opts.ratingSheetAlreadyOpenForOrder) return "skip";
  if (opts.overlayBlocking || opts.deferForUnpaidPayNow) return "defer";
  return "open";
}
