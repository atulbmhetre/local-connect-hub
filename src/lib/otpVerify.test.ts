import { describe, expect, it } from "vitest";
import { classifyOtpVerifyError, OTP_RESEND_COOLDOWN_MS } from "@/lib/otpVerify";

describe("classifyOtpVerifyError (H6)", () => {
  it("treats GoTrue expired-token wording as expired", () => {
    expect(classifyOtpVerifyError("Token has expired or is invalid")).toBe("expired");
    expect(classifyOtpVerifyError("otp_expired")).toBe("expired");
    expect(classifyOtpVerifyError("OTP has expired")).toBe("expired");
  });

  it("treats other failures as wrong-code", () => {
    expect(classifyOtpVerifyError("Invalid OTP")).toBe("wrong");
    expect(classifyOtpVerifyError("Token is invalid")).toBe("wrong");
    expect(classifyOtpVerifyError(null)).toBe("wrong");
    expect(classifyOtpVerifyError(undefined)).toBe("wrong");
  });

  it("uses a 30s resend cooldown (practical Auth SMS cooldown)", () => {
    expect(OTP_RESEND_COOLDOWN_MS).toBe(30_000);
  });
});
