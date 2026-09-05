import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { strings } from "@/lib/strings";
import { OTP_RESEND_COOLDOWN_MS } from "@/lib/otpVerify";

const mockRequestPhoneOtp = vi.fn();
const mockVerifyPhoneOtp = vi.fn();

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/userIdentity", () => ({
  requestPhoneOtp: (...args: unknown[]) => mockRequestPhoneOtp(...args),
  verifyPhoneOtp: (...args: unknown[]) => mockVerifyPhoneOtp(...args),
}));

import { PhoneOtpVerification } from "@/components/PhoneOtpVerification";

describe("PhoneOtpVerification (H6)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockRequestPhoneOtp.mockReset();
    mockVerifyPhoneOtp.mockReset();
    mockRequestPhoneOtp.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a distinct expired-code message vs wrong-code", async () => {
    mockVerifyPhoneOtp
      .mockResolvedValueOnce({
        success: false,
        error: "Token has expired or is invalid",
      })
      .mockResolvedValueOnce({
        success: false,
        error: "Invalid OTP",
      });

    render(
      <PhoneOtpVerification phone="9876543210" onVerified={() => {}} />,
    );

    await waitFor(() => expect(screen.getByTestId("otp-input")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("otp-input"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByTestId("otp-verify-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("otp-error")).toHaveTextContent(
        strings.en.firstopen_otp_expired,
      );
    });
    expect(screen.getByTestId("otp-error")).not.toHaveTextContent(
      strings.en.firstopen_otp_wrong,
    );

    fireEvent.change(screen.getByTestId("otp-input"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByTestId("otp-verify-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("otp-error")).toHaveTextContent(
        strings.en.firstopen_otp_wrong,
      );
    });
  });

  it("offers resend after the cooldown even when the initial send succeeded", async () => {
    render(
      <PhoneOtpVerification phone="9876543210" onVerified={() => {}} />,
    );

    await waitFor(() => expect(screen.getByTestId("otp-resend-btn")).toBeInTheDocument());

    const resend = screen.getByTestId("otp-resend-btn");
    expect(resend).toBeDisabled();
    expect(resend).toHaveTextContent(/Resend code in/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OTP_RESEND_COOLDOWN_MS + 50);
    });

    await waitFor(() => {
      expect(resend).not.toBeDisabled();
      expect(resend).toHaveTextContent(strings.en.firstopen_otp_resend);
    });

    mockRequestPhoneOtp.mockClear();
    fireEvent.click(resend);
    await waitFor(() => expect(mockRequestPhoneOtp).toHaveBeenCalledTimes(1));
  });
});
