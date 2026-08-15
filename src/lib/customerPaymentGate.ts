export type CustomerPaymentGateOrder = {
  service_mode?: string | null;
  delivery_fulfillment_method?: string | null;
  delivery_payment_timing?: string | null;
  vendors?: { service_mode?: string | null } | null;
};

export type CustomerPaymentGateBill = {
  payment_mode: string;
  payment_status: string;
};

/**
 * Order-level eligibility for customer self-declare (ignores account restriction).
 */
export function isCustomerSelfDeclarePaymentEligible(
  order: CustomerPaymentGateOrder,
  bill: CustomerPaymentGateBill,
): boolean {
  if (bill.payment_status !== "unpaid") return false;
  if (bill.payment_mode !== "upi") return false;

  const mode = String(order.service_mode ?? order.vendors?.service_mode ?? "")
    .trim()
    .toLowerCase();
  if (mode !== "delivery") return false;
  if (order.delivery_fulfillment_method !== "agent") return false;
  if (order.delivery_payment_timing !== "prepaid") return false;

  return true;
}

/**
 * Customer self-declare (Pay Now / UTR) is only for prepaid agent-delivery UPI bills
 * when the account is not cash-only restricted from payment disputes.
 */
export function canCustomerSelfDeclarePayment(
  order: CustomerPaymentGateOrder,
  bill: CustomerPaymentGateBill,
  isPaymentSelfDeclareRestricted: boolean,
): boolean {
  if (isPaymentSelfDeclareRestricted) return false;
  return isCustomerSelfDeclarePaymentEligible(order, bill);
}
