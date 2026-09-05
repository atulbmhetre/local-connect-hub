import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MyOrders auto-rating unpaid / reopen wiring", () => {
  const src = readFileSync(resolve("src/pages/MyOrders.tsx"), "utf8");

  it("defers auto-rating while unpaid Pay Now is on screen", () => {
    expect(src).toContain("shouldDeferAutoRatingForUnpaidPayNow");
    expect(src).toContain("billBlocksDismiss(bill, r.payment_status)");
    expect(src).toContain("openedPaymentOrderIdsRef");
    expect(src).toContain("billsLoaded");
    expect(src).toMatch(/if \(loading \|\| !billsLoaded \|\| rows\.length === 0\) return/);
  });

  it("skips retry-after-close when the sheet is already open for that order", () => {
    expect(src).toContain("resolveAutoRatingAction");
    expect(src).toContain("ratingSheetAlreadyOpenForOrder");
    expect(src).toContain("ratingOpenForIdRef.current === r.id");
    expect(src).toContain("consumeAutoRatingForOrder(r.id)");
  });

  it("records payment-opened only after the payment sheet actually opens", () => {
    expect(src).toContain("openedPaymentOrderIdsRef.current.add(r.id)");
    const openIdx = src.indexOf("openedPaymentOrderIdsRef.current.add(r.id)");
    const sheetIdx = src.indexOf("setPaymentSheetOrder({");
    expect(openIdx).toBeGreaterThan(-1);
    expect(sheetIdx).toBeGreaterThan(openIdx);
  });

  it("does not add an Issue confirmation step — the unpaid gate is the source fix", () => {
    const rating = readFileSync(resolve("src/components/RatingSheet.tsx"), "utf8");
    expect(rating).toContain("increment_vendor_issues");
    expect(rating).not.toMatch(/did you mean to report an issue/i);
  });
});
