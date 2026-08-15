import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { strings } from "@/lib/strings";
import { MIN_PAYMENT_AWAY_MS } from "@/lib/paymentResume";

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
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn() },
}));

const UTR = "123456789012";

function renderPanel(amountRupees = 250) {
  return render(
    <UpiPaymentPanel
      idPrefix="test-panel"
      orderId="req-1"
      paymentStatus="unpaid"
      amountRupees={amountRupees}
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
  fireEvent.click(screen.getByText(strings.en.payment_pay_now));
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + MIN_PAYMENT_AWAY_MS);
  fireEvent(document, new Event("visibilitychange"));
  fireEvent.click(await screen.findByText(strings.en.payment_yesPaid));
  nowSpy.mockRestore();
  fireEvent.change(screen.getByLabelText(strings.en.payment_enter_utr), {
    target: { value: UTR },
  });
  fireEvent.click(screen.getByText(strings.en.payment_submit_utr));
}

describe("UpiPaymentPanel payment_claimed vendor notification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("open", vi.fn());
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      return { data: null, error: null };
    });
  });

  it("resolves the VENDOR's own language for the notification, not the customer's", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
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
    const sentTitle = mockInvokeNotifyVendor.mock.calls[0][0].notification_title;
    expect(sentTitle).not.toBe(strings.en.payment_pay_now);
  });

  it("falls back to English copy and captures the error when the vendor language lookup fails", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
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

  it("does not show the resume prompt if the customer returns before the minimum away duration", () => {
    vi.useFakeTimers();
    try {
      renderPanel();
      fireEvent.click(screen.getByText(strings.en.payment_pay_now));
      vi.advanceTimersByTime(MIN_PAYMENT_AWAY_MS - 1);
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.queryByTestId("test-panel-return-prompt")).not.toBeInTheDocument();

      vi.advanceTimersByTime(1);
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.getByTestId("test-panel-return-prompt")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows vendor-resolve guidance when restricted claim fails on the blocking bill", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      if (name === "claim_customer_payment") {
        return { data: null, error: { message: "payment_self_declare_restricted" } };
      }
      if (name === "get_customer_payment_block_status") {
        return {
          data: [{ is_blocked: true, request_id: "req-1", vendor_name: "Test Shop", amount: 300 }],
          error: null,
        };
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("get_customer_payment_block_status", {
        p_device_id: "test-device",
        p_user_phone: "9876543210",
      });
    });
  });
});
