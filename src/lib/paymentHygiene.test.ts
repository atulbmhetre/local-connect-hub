import { describe, expect, it } from "vitest";
import {
  PAYMENT_HYGIENE_TIER1_MS,
  isBillPastPaymentHygieneTier1,
} from "@/lib/paymentHygiene";

describe("paymentHygiene", () => {
  it("flags unpaid bills past tier-1 age", () => {
    const old = new Date(Date.now() - PAYMENT_HYGIENE_TIER1_MS - 1000).toISOString();
    expect(isBillPastPaymentHygieneTier1(old, "unpaid")).toBe(true);
  });

  it("does not flag recent unpaid bills", () => {
    const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(isBillPastPaymentHygieneTier1(recent, "unpaid")).toBe(false);
  });

  it("does not flag paid bills regardless of age", () => {
    const old = new Date(Date.now() - PAYMENT_HYGIENE_TIER1_MS - 1000).toISOString();
    expect(isBillPastPaymentHygieneTier1(old, "paid")).toBe(false);
  });
});
