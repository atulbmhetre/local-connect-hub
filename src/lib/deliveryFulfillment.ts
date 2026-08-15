export type DeliveryFulfillmentMethod = "vendor" | "agent";
export type DeliveryPaymentTiming = "prepaid" | "postpaid";

export const DEFAULT_DELIVERY_FULFILLMENT: DeliveryFulfillmentMethod = "vendor";
export const DEFAULT_DELIVERY_PAYMENT_TIMING: DeliveryPaymentTiming = "postpaid";

export function normalizeDeliveryFulfillmentMethod(
  value: string | null | undefined,
): DeliveryFulfillmentMethod {
  return value === "agent" ? "agent" : "vendor";
}

export function normalizeDeliveryPaymentTiming(
  value: string | null | undefined,
): DeliveryPaymentTiming {
  return value === "prepaid" ? "prepaid" : "postpaid";
}

export function deliveryPaymentTimingForFulfillment(
  fulfillment: DeliveryFulfillmentMethod,
  timing: DeliveryPaymentTiming,
): DeliveryPaymentTiming {
  return fulfillment === "vendor" ? "postpaid" : timing;
}
