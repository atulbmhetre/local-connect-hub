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
