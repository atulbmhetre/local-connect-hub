import { describe, expect, it } from "vitest";
import { formatVisitFeeAmount, parseInspectionFeeInput } from "./visitFee";

describe("parseInspectionFeeInput", () => {
  it("treats blank and zero as unset", () => {
    expect(parseInspectionFeeInput("")).toBeNull();
    expect(parseInspectionFeeInput("  ")).toBeNull();
    expect(parseInspectionFeeInput("0")).toBeNull();
  });

  it("rounds a positive rupee amount", () => {
    expect(parseInspectionFeeInput("100")).toBe(100);
    expect(parseInspectionFeeInput("99.4")).toBe(99);
  });

  it("rejects negatives and junk", () => {
    expect(parseInspectionFeeInput("-10")).toBeNull();
    expect(parseInspectionFeeInput("abc")).toBeNull();
  });
});

describe("formatVisitFeeAmount", () => {
  it("returns null when unset", () => {
    expect(formatVisitFeeAmount(null)).toBeNull();
    expect(formatVisitFeeAmount(0)).toBeNull();
  });

  it("rounds a stored numeric", () => {
    expect(formatVisitFeeAmount(100.4)).toBe(100);
  });
});
