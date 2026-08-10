import { describe, expect, it } from "vitest";
import { strings } from "@/lib/strings";
import {
  filterKhataLedgerByOutstanding,
  formatKhataBalanceDisplay,
  isKhataLedgerUnsettled,
  khataOutstandingColorClass,
  mapKhataRefundError,
  resolveKhataTxBusinessChip,
} from "@/lib/khataDisplay";

const s = strings.en;

describe("khataOutstandingColorClass", () => {
  const amberLimit = 100;
  const redLimit = 200;

  it("returns blue for negative outstanding (vendor owes customer)", () => {
    expect(khataOutstandingColorClass(-70, amberLimit, redLimit)).toBe("text-blue-400");
  });

  it("returns green for zero through amberLimit - 1", () => {
    expect(khataOutstandingColorClass(0, amberLimit, redLimit)).toBe("text-green-400");
    expect(khataOutstandingColorClass(50, amberLimit, redLimit)).toBe("text-green-400");
    expect(khataOutstandingColorClass(99, amberLimit, redLimit)).toBe("text-green-400");
  });

  it("returns amber from amberLimit through redLimit - 1", () => {
    expect(khataOutstandingColorClass(100, amberLimit, redLimit)).toBe("text-amber-400");
    expect(khataOutstandingColorClass(150, amberLimit, redLimit)).toBe("text-amber-400");
    expect(khataOutstandingColorClass(199, amberLimit, redLimit)).toBe("text-amber-400");
  });

  it("returns red at or above redLimit", () => {
    expect(khataOutstandingColorClass(200, amberLimit, redLimit)).toBe("text-red-400");
    expect(khataOutstandingColorClass(500, amberLimit, redLimit)).toBe("text-red-400");
  });
});

describe("isKhataLedgerUnsettled", () => {
  it("returns false for zero (settled)", () => {
    expect(isKhataLedgerUnsettled(0)).toBe(false);
  });

  it("returns true for positive outstanding", () => {
    expect(isKhataLedgerUnsettled(120)).toBe(true);
  });

  it("returns true for negative outstanding (customer credit)", () => {
    expect(isKhataLedgerUnsettled(-70)).toBe(true);
  });
});

describe("filterKhataLedgerByOutstanding", () => {
  const entries = [
    { user_phone: "111", total_outstanding: 150 },
    { user_phone: "222", total_outstanding: 0 },
    { user_phone: "333", total_outstanding: -70 },
  ];

  it("includes positive and negative entries when showFullHistory is false", () => {
    const filtered = filterKhataLedgerByOutstanding(entries, false);
    expect(filtered.map((e) => e.user_phone)).toEqual(["111", "333"]);
  });

  it("excludes zero-balance entries when showFullHistory is false", () => {
    const filtered = filterKhataLedgerByOutstanding(entries, false);
    expect(filtered.some((e) => e.total_outstanding === 0)).toBe(false);
  });

  it("returns all entries when showFullHistory is true", () => {
    expect(filterKhataLedgerByOutstanding(entries, true)).toEqual(entries);
  });
});

describe("formatKhataBalanceDisplay", () => {
  it("prefixes negative balance with refund-due label and blue class", () => {
    const result = formatKhataBalanceDisplay(-70, s, 100, 200);
    expect(result.text).toBe("Refund due: ₹70.00");
    expect(result.colorClass).toBe("text-blue-400");
  });

  it("formats positive balance as rupee amount with threshold color", () => {
    const result = formatKhataBalanceDisplay(150, s, 100, 200);
    expect(result.text).toBe("₹150.00");
    expect(result.colorClass).toBe("text-amber-400");
  });

  it("formats zero as settled green amount", () => {
    const result = formatKhataBalanceDisplay(0, s, 100, 200);
    expect(result.text).toBe("₹0.00");
    expect(result.colorClass).toBe("text-green-400");
  });
});

describe("mapKhataRefundError", () => {
  it("maps no_customer_credit to localized message", () => {
    expect(mapKhataRefundError("no_customer_credit", s)).toBe(s.khata_errNoCustomerCredit);
  });

  it("maps amount_exceeds_credit to localized message", () => {
    expect(mapKhataRefundError("amount_exceeds_credit", s)).toBe(s.khata_errAmountExceedsCredit);
  });

  it("maps invalid_amount to localized message", () => {
    expect(mapKhataRefundError("invalid_amount", s)).toBe(s.khata_errInvalidAmount);
  });

  it("returns the original message for unrecognized codes", () => {
    const raw = "ledger_not_found";
    expect(mapKhataRefundError(raw, s)).toBe(raw);
  });
});

describe("resolveKhataTxBusinessChip", () => {
  it("shows business chip when request has category label", () => {
    expect(
      resolveKhataTxBusinessChip({
        request_id: "r1",
        category_label: "Cobbler",
        category_emoji: "👞",
        payment_mode: "khata",
      }),
    ).toEqual({ kind: "business", emoji: "👞", label: "Cobbler" });
  });

  it("shows Payment for paid lines without request", () => {
    expect(
      resolveKhataTxBusinessChip({
        request_id: null,
        category_label: null,
        payment_mode: "paid",
      }),
    ).toEqual({ kind: "payment" });
  });

  it("shows Refund for non-paid lines without request (no false business)", () => {
    expect(
      resolveKhataTxBusinessChip({
        request_id: null,
        category_label: "Cobbler",
        payment_mode: "khata",
      }),
    ).toEqual({ kind: "refund" });
  });
});
