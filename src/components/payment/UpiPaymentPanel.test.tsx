import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { strings } from "@/lib/strings";

const { mockRpc, mockInvokeNotifyVendor, captureError } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInvokeNotifyVendor: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc },
  invokeNotifyVendor: mockInvokeNotifyVendor,
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9876543210" }));

vi.mock("@/lib/language", () => ({
  // The paying CUSTOMER's session language is English — the vendor
  // notification must NOT inherit it.
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn() },
}));

const UTR = "123456789012";

function renderPanel() {
  return render(
    <UpiPaymentPanel
      idPrefix="test-panel"
      orderId="req-1"
      paymentStatus="unpaid"
      amountRupees={250}
      vendorId="vendor-1"
      shopName="Test Shop"
      upiId="shop@upi"
      vendorPhone="9000000000"
      qrUrl={null}
      qrPayeeId={null}
    />,
  );
}

async function payAndSubmitUtr() {
  // Tap Pay Now (opens the UPI deep link), simulate returning to the tab,
  // answer "Yes" to the resume prompt, then submit the UTR.
  fireEvent.click(screen.getByText(strings.en.payment_pay_now));
  fireEvent(document, new Event("visibilitychange"));
  fireEvent.click(await screen.findByText(strings.en.payment_yesPaid));
  fireEvent.change(screen.getByLabelText(strings.en.payment_enter_utr), {
    target: { value: UTR },
  });
  fireEvent.click(screen.getByText(strings.en.payment_submit_utr));
}

describe("UpiPaymentPanel payment_claimed vendor notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("open", vi.fn());
  });

  it("resolves the VENDOR's own language for the notification, not the customer's", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "claim_customer_payment") return { data: null, error: null };
      if (name === "resolve_user_lang") return { data: "hi", error: null };
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(mockInvokeNotifyVendor).toHaveBeenCalledTimes(1);
    });

    expect(mockRpc).toHaveBeenCalledWith("resolve_user_lang", {
      p_user_phone: "9000000000",
    });
    expect(mockInvokeNotifyVendor).toHaveBeenCalledWith({
      vendor_id: "vendor-1",
      notification_title: strings.hi.notifyVendor_paymentClaimed_title,
      message: strings.hi.notifyVendor_paymentClaimed_body("250.00", UTR),
      type: "payment_claimed",
      request_id: "req-1",
    });
    // Regression: the old code sent the customer-language "Pay Now" as title.
    const sentTitle = mockInvokeNotifyVendor.mock.calls[0][0].notification_title;
    expect(sentTitle).not.toBe(strings.en.payment_pay_now);
  });

  it("falls back to English copy and captures the error when the vendor language lookup fails", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "claim_customer_payment") return { data: null, error: null };
      if (name === "resolve_user_lang") {
        return { data: null, error: { message: "lang lookup failed" } };
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(mockInvokeNotifyVendor).toHaveBeenCalledTimes(1);
    });

    expect(captureError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "upiPaymentPanel.resolveVendorLang", orderId: "req-1" }),
    );
    expect(mockInvokeNotifyVendor).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_title: strings.en.notifyVendor_paymentClaimed_title,
        message: strings.en.notifyVendor_paymentClaimed_body("250.00", UTR),
        type: "payment_claimed",
      }),
    );
  });
});
