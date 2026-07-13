import { describe, expect, it } from "vitest";
import {
  isKhataRedLimitExceededError,
  messageForKhataChargeError,
} from "./khataBillErrors";
import { strings } from "./strings";

describe("khataBillErrors", () => {
  it("detects khata_red_limit_exceeded in RPC messages", () => {
    expect(isKhataRedLimitExceededError("khata_red_limit_exceeded")).toBe(true);
    expect(
      isKhataRedLimitExceededError(
        'ERROR: khata_red_limit_exceeded\nDETAIL: ...',
      ),
    ).toBe(true);
    expect(isKhataRedLimitExceededError("bill_already_khata")).toBe(false);
    expect(isKhataRedLimitExceededError(null)).toBe(false);
  });

  it("maps khata_red_limit_exceeded to localized string (en/hi/mr)", () => {
    for (const lang of ["en", "hi", "mr"] as const) {
      const s = strings[lang];
      expect(
        messageForKhataChargeError(
          "khata_red_limit_exceeded",
          s.khata_errAlreadyAtRedLimit,
          s.bill_sendFailed,
        ),
      ).toBe(s.khata_errAlreadyAtRedLimit);
      expect(s.khata_errAlreadyAtRedLimit.length).toBeGreaterThan(20);
    }
    expect(strings.en.khata_errAlreadyAtRedLimit).toMatch(/credit limit/i);
  });

  it("falls back for other errors", () => {
    expect(
      messageForKhataChargeError(
        "bill_send_failed",
        strings.en.khata_errAlreadyAtRedLimit,
        strings.en.bill_sendFailed,
      ),
    ).toBe(strings.en.bill_sendFailed);
  });
});
