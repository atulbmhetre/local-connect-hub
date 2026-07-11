/** UPI payment reference (UTR) — 12 digits, matches claim_customer_payment RPC. */
export const PAYMENT_UTR_REGEX = /^\d{12}$/;

export function isValidPaymentUtr(utr: string): boolean {
  return PAYMENT_UTR_REGEX.test(utr.trim());
}
