import { describe, expect, it } from "vitest";
import {
  canCustomerSelfDeclarePayment,
  isCustomerSelfDeclarePaymentEligible,
} from "@/lib/customerPaymentGate";

const baseOrder = {
  service_mode: "delivery" as const,
  delivery_fulfillment_method: "agent" as const,
  delivery_payment_timing: "prepaid" as const,
};

const upiUnpaid = { payment_mode: "upi", payment_status: "unpaid" };

describe("isCustomerSelfDeclarePaymentEligible", () => {
  it("allows agent + prepaid + delivery + UPI unpaid", () => {
    expect(isCustomerSelfDeclarePaymentEligible(baseOrder, upiUnpaid)).toBe(true);
  });

  it("denies help orders", () => {
    expect(
      isCustomerSelfDeclarePaymentEligible({ ...baseOrder, service_mode: "help" }, upiUnpaid),
    ).toBe(false);
  });
});

describe("canCustomerSelfDeclarePayment", () => {
  it("allows agent + prepaid + delivery + UPI unpaid when not restricted", () => {
    expect(canCustomerSelfDeclarePayment(baseOrder, upiUnpaid, false)).toBe(true);
  });

  it("denies when payment self-declare is restricted", () => {
    expect(canCustomerSelfDeclarePayment(baseOrder, upiUnpaid, true)).toBe(false);
  });

  it("denies help orders", () => {
    expect(
      canCustomerSelfDeclarePayment({ ...baseOrder, service_mode: "help" }, upiUnpaid, false),
    ).toBe(false);
  });

  it("denies appointment orders", () => {
    expect(
      canCustomerSelfDeclarePayment(
        { ...baseOrder, service_mode: "appointment" },
        upiUnpaid,
        false,
      ),
    ).toBe(false);
  });

  it("denies vendor-self delivery", () => {
    expect(
      canCustomerSelfDeclarePayment(
        { ...baseOrder, delivery_fulfillment_method: "vendor" },
        upiUnpaid,
        false,
      ),
    ).toBe(false);
  });

  it("denies agent postpaid delivery", () => {
    expect(
      canCustomerSelfDeclarePayment(
        { ...baseOrder, delivery_payment_timing: "postpaid" },
        upiUnpaid,
        false,
      ),
    ).toBe(false);
  });

  it("denies cash bills", () => {
    expect(
      canCustomerSelfDeclarePayment(baseOrder, {
        payment_mode: "cash",
        payment_status: "unpaid",
      }, false),
    ).toBe(false);
  });

  it("denies khata bills", () => {
    expect(
      canCustomerSelfDeclarePayment(baseOrder, {
        payment_mode: "khata",
        payment_status: "unpaid",
      }, false),
    ).toBe(false);
  });

  it("denies paid bills", () => {
    expect(
      canCustomerSelfDeclarePayment(baseOrder, {
        payment_mode: "upi",
        payment_status: "paid",
      }, false),
    ).toBe(false);
  });
});
