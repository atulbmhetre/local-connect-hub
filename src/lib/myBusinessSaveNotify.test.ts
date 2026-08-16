import { describe, expect, it } from "vitest";
import { myBusinessSaveVerificationNotifyReasons } from "@/lib/myBusinessSaveNotify";

describe("myBusinessSaveVerificationNotifyReasons", () => {
  it("returns empty when nothing verification-relevant changed (no-op / operational Save)", () => {
    expect(
      myBusinessSaveVerificationNotifyReasons({ phoneChanged: false, upiChanged: false }),
    ).toEqual([]);
  });

  it("includes phone when phone changed", () => {
    expect(
      myBusinessSaveVerificationNotifyReasons({ phoneChanged: true, upiChanged: false }),
    ).toEqual(["phone"]);
  });

  it("includes upi_id when UPI changed", () => {
    expect(
      myBusinessSaveVerificationNotifyReasons({ phoneChanged: false, upiChanged: true }),
    ).toEqual(["upi_id"]);
  });

  it("includes both when phone and UPI changed", () => {
    expect(
      myBusinessSaveVerificationNotifyReasons({ phoneChanged: true, upiChanged: true }),
    ).toEqual(["phone", "upi_id"]);
  });
});
