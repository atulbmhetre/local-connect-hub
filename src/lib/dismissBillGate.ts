/**
 * Dismiss vs unpaid bill gates.
 * Cash/UPI unpaid blocks dismiss (orphan risk). Khata unpaid is tracked on the
 * ledger — vendor uses existing settle-dues block; cash/UPI can clear via paid
 * or add_bill_to_khata.
 *
 * Exception: when the request payment_status is disputed, dismiss is allowed
 * even if the bill is still unpaid — dispute stays on the record (ratings /
 * trust); there is no admin arbitration path.
 */

export type DismissBillSlice = {
  payment_status?: string | null;
  payment_mode?: string | null;
};

export function isUnpaidBillStatus(status: string | null | undefined): boolean {
  return String(status ?? "")
    .trim()
    .toLowerCase() === "unpaid";
}

export function isCashOrUpiMode(mode: string | null | undefined): boolean {
  const m = String(mode ?? "")
    .trim()
    .toLowerCase();
  return m === "cash" || m === "upi" || m === "";
}

export function isDisputedRequestPayment(
  requestPaymentStatus: string | null | undefined,
): boolean {
  return String(requestPaymentStatus ?? "")
    .trim()
    .toLowerCase() === "disputed";
}

/** True when an unpaid cash/UPI bill would orphan if dismissed (not disputed). */
export function billBlocksDismiss(
  bill: DismissBillSlice | null | undefined,
  requestPaymentStatus?: string | null,
): boolean {
  if (isDisputedRequestPayment(requestPaymentStatus)) return false;
  if (!bill) return false;
  if (!isUnpaidBillStatus(bill.payment_status)) return false;
  return isCashOrUpiMode(bill.payment_mode);
}

/**
 * Cancel → blocked dismiss → normal dismiss ordering for customer My Orders.
 * Cancel wins whenever the cancel gate is open; unpaid cash/UPI only matters
 * once cancel is unavailable (and payment is not disputed).
 */
export type CustomerDismissSurfaceAction = "cancel" | "dismiss" | "blocked_unpaid";

export function resolveCustomerDismissSurfaceAction(opts: {
  cancelAvailable: boolean;
  bill?: DismissBillSlice | null;
  requestPaymentStatus?: string | null;
}): CustomerDismissSurfaceAction {
  if (opts.cancelAvailable) return "cancel";
  if (billBlocksDismiss(opts.bill, opts.requestPaymentStatus)) return "blocked_unpaid";
  return "dismiss";
}
