/** Folded comparison of billed (bill-create) vs live Pay-screen destinations. */

export type BilledPaymentDestination = {
  billed_upi_id: string | null;
  billed_upi_qr_url: string | null;
  billed_upi_payee_id: string | null;
  billed_payment_phone: string | null;
  billed_payment_snapshot_at: string | null;
};

export type LivePaymentDestination = {
  upiId: string | null | undefined;
  qrUrl: string | null | undefined;
  qrPayeeId: string | null | undefined;
  paymentPhone: string | null | undefined;
};

export function foldPaymentText(raw: string | null | undefined): string {
  return String(raw ?? "").trim().toLowerCase();
}

export function foldPaymentPhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

/**
 * True when the Pay screen's live UPI / QR / mobile differs from the freeze
 * taken at UPI bill create. No snapshot (legacy bills) → no notice.
 */
export function paymentDestinationsChanged(
  billed: BilledPaymentDestination | null | undefined,
  live: LivePaymentDestination,
): boolean {
  if (!billed?.billed_payment_snapshot_at) return false;
  if (foldPaymentText(billed.billed_upi_id) !== foldPaymentText(live.upiId)) return true;
  if (foldPaymentText(billed.billed_upi_qr_url) !== foldPaymentText(live.qrUrl)) return true;
  if (foldPaymentText(billed.billed_upi_payee_id) !== foldPaymentText(live.qrPayeeId)) {
    return true;
  }
  if (foldPaymentPhone(billed.billed_payment_phone) !== foldPaymentPhone(live.paymentPhone)) {
    return true;
  }
  return false;
}

/** True when the billed QR image URL differs from the live Pay-screen URL. */
export function paymentQrUrlChanged(
  billed: BilledPaymentDestination | null | undefined,
  live: LivePaymentDestination,
): boolean {
  if (!billed?.billed_payment_snapshot_at) return false;
  return foldPaymentText(billed.billed_upi_qr_url) !== foldPaymentText(live.qrUrl);
}
