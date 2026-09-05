import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { UpiPaymentPanel } from "@/components/payment/UpiPaymentPanel";
import { strings } from "@/lib/strings";
import { MIN_PAYMENT_AWAY_MS } from "@/lib/paymentResume";
import * as withNetworkRetryMod from "@/lib/withNetworkRetry";

const {
  mockRpc,
  mockFrom,
  mockInvokeNotifyVendor,
  captureError,
  showNetworkFailedToast,
  showNetworkRetryingToast,
  toastError,
} = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockInvokeNotifyVendor: vi.fn(),
  captureError: vi.fn(),
  showNetworkFailedToast: vi.fn(),
  showNetworkRetryingToast: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
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

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast,
  showNetworkFailedToast,
  dismissNetworkRetryingToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/withNetworkRetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/withNetworkRetry")>();
  return {
    ...actual,
    withTimedRetry: vi.fn(
      async (
        fn: (signal: AbortSignal) => Promise<unknown>,
        opts?: Parameters<typeof actual.withTimedRetry>[1],
      ) =>
        actual.withTimedRetry(fn, {
          ...opts,
          maxAttempts: 3,
          baseDelayMs: 1,
          timeoutMs: opts?.timeoutMs ?? 15_000,
        }),
    ),
  };
});

const UTR = "123456789012";

const MATCHING_BILLED = {
  billed_upi_id: "shop@upi",
  billed_upi_qr_url: null,
  billed_upi_payee_id: null,
  billed_payment_phone: "9000000000",
  billed_payment_snapshot_at: "2026-08-30T07:00:00Z",
};

function mockBilledRow(row: typeof MATCHING_BILLED | null) {
  mockFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: async () => ({ data: row, error: null }),
      }),
    }),
  });
}

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
  await waitFor(() => expect(mockFrom).toHaveBeenCalled());
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
    mockBilledRow(MATCHING_BILLED);
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

  it("snapshots intended UPI payee when the unpaid payment sheet is generated", async () => {
    renderPanel();
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("snapshot_intended_upi_payee", {
        p_request_id: "req-1",
        p_device_id: "test-device",
        p_user_phone: "9876543210",
      });
    });
  });

  it("does not snapshot intended UPI when payment is already claimed", () => {
    render(
      <UpiPaymentPanel
        idPrefix="test-panel"
        orderId="req-claimed"
        paymentStatus="claimed"
        amountRupees={250}
        vendorId="vendor-1"
        shopName="Test Shop"
        upiId="shop@upi"
        vendorPhone="9000000000"
        qrUrl={null}
        qrPayeeId={null}
      />,
    );
    expect(mockRpc).not.toHaveBeenCalledWith(
      "snapshot_intended_upi_payee",
      expect.anything(),
    );
  });

  it("claims payment without client invokeNotifyVendor", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      if (name === "claim_customer_payment") return { data: null, error: null };
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "claim_customer_payment",
        expect.objectContaining({
          p_request_id: "req-1",
          p_payment_utr: UTR,
        }),
      );
    });
    expect(mockInvokeNotifyVendor).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith("resolve_user_lang", expect.anything());
  });

  it("does not show the resume prompt if the customer returns before the minimum away duration", async () => {
    renderPanel();
    await waitFor(() => expect(mockFrom).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
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
    await waitFor(() => {
      expect(screen.getByText(strings.en.payment_submit_utr)).not.toBeDisabled();
    });
  });

  it("retries claim_customer_payment on network blip then succeeds (submit not stuck)", async () => {
    let claimAttempts = 0;
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      if (name === "claim_customer_payment") {
        claimAttempts += 1;
        if (claimAttempts === 1) {
          return { data: null, error: { message: "Failed to fetch" } };
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(claimAttempts).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(screen.getByText(strings.en.payment_claimed)).toBeInTheDocument();
    });
    expect(showNetworkRetryingToast).toHaveBeenCalled();
    expect(showNetworkFailedToast).not.toHaveBeenCalled();
    expect(withNetworkRetryMod.withTimedRetry).toHaveBeenCalled();
  });

  it("times out a hung claim_customer_payment and shows network failed retry", async () => {
    const actual = await vi.importActual<typeof import("@/lib/withNetworkRetry")>(
      "@/lib/withNetworkRetry",
    );
    vi.mocked(withNetworkRetryMod.withTimedRetry).mockImplementation(
      async (fn, opts) =>
        actual.withTimedRetry(fn, {
          ...opts,
          maxAttempts: 2,
          baseDelayMs: 1,
          timeoutMs: 80,
        }),
    );

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      if (name === "claim_customer_payment") {
        return new Promise(() => {});
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(
      () => {
        expect(showNetworkFailedToast).toHaveBeenCalled();
      },
      { timeout: 5_000 },
    );
    expect(screen.getByText(strings.en.payment_submit_utr)).not.toBeDisabled();
    expect(
      mockRpc.mock.calls.filter((call) => call[0] === "claim_customer_payment").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("shows network failed toast and re-enables submit after retries exhaust", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_payment_claim_requirements") {
        return {
          data: { requires_screenshot: false, is_anomalous: false },
          error: null,
        };
      }
      if (name === "claim_customer_payment") {
        return { data: null, error: { message: "Failed to fetch" } };
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(showNetworkFailedToast).toHaveBeenCalled();
    });
    expect(screen.getByText(strings.en.payment_submit_utr)).not.toBeDisabled();
    expect(toastError).not.toHaveBeenCalledWith(strings.en.payment_confirm_error);
  });

  it("resets submit state when payment block status lookup throws", async () => {
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
        throw new Error("block status blew up");
      }
      return { data: null, error: null };
    });

    renderPanel();
    await payAndSubmitUtr();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(strings.en.payment_confirm_error);
    });
    expect(screen.getByText(strings.en.payment_submit_utr)).not.toBeDisabled();
    expect(captureError).toHaveBeenCalled();
  });

  it("shows one notice when live Pay destinations differ from the bill freeze", async () => {
    mockBilledRow({
      ...MATCHING_BILLED,
      billed_upi_id: "old@upi",
      billed_upi_qr_url: "https://cdn.example/old.png",
      billed_upi_payee_id: "old@upi",
      billed_payment_phone: "9000000001",
    });
    render(
      <UpiPaymentPanel
        idPrefix="test-panel"
        orderId="req-1"
        paymentStatus="unpaid"
        amountRupees={250}
        vendorId="vendor-1"
        shopName="Test Shop"
        upiId="new@upi"
        vendorPhone="9000000002"
        qrUrl="https://cdn.example/new.png"
        qrPayeeId="new@upi"
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("test-panel-payment-details-updated")).toHaveTextContent(
        strings.en.payment_details_updated_qr,
      );
    });
    expect(screen.getByTestId("test-panel-upi-id")).toHaveTextContent("new@upi");
    fireEvent.click(screen.getByText(strings.en.payment_tab_mobile));
    expect(screen.getByTestId("test-panel-mobile")).toHaveTextContent("9000000002");
    fireEvent.click(screen.getByText(strings.en.payment_tab_qr));
    expect(screen.queryByTestId("test-panel-qr-image")).not.toBeInTheDocument();
    expect(screen.getByText(strings.en.payment_pay_now)).toBeInTheDocument();
    expect(screen.getAllByTestId("test-panel-payment-details-updated")).toHaveLength(1);
  });

  it("hides the raw QR image when a payee ID exists even if a URL is set", async () => {
    render(
      <UpiPaymentPanel
        idPrefix="test-panel"
        orderId="req-1"
        paymentStatus="unpaid"
        amountRupees={250}
        vendorId="vendor-1"
        shopName="Test Shop"
        upiId="shop@upi"
        vendorPhone="9000000000"
        qrUrl="https://example.com/decoy-qr.png"
        qrPayeeId="fixture-vendor@okhdfcbank"
      />,
    );
    await waitFor(() => expect(mockFrom).toHaveBeenCalled());
    fireEvent.click(screen.getByText(strings.en.payment_tab_qr));
    expect(screen.queryByTestId("test-panel-qr-image")).not.toBeInTheDocument();
    expect(screen.getByText(strings.en.payment_pay_now)).toBeInTheDocument();
    expect(screen.queryByText(strings.en.payment_scan_instruction)).not.toBeInTheDocument();
  });

  it("still shows the static QR image when there is a URL but no payee ID", async () => {
    render(
      <UpiPaymentPanel
        idPrefix="test-panel"
        orderId="req-1"
        paymentStatus="unpaid"
        amountRupees={250}
        vendorId="vendor-1"
        shopName="Test Shop"
        upiId="shop@upi"
        vendorPhone="9000000000"
        qrUrl="https://cdn.example/static-qr.png"
        qrPayeeId={null}
      />,
    );
    await waitFor(() => expect(mockFrom).toHaveBeenCalled());
    fireEvent.click(screen.getByText(strings.en.payment_tab_qr));
    expect(screen.getByTestId("test-panel-qr-image")).toHaveAttribute(
      "src",
      "https://cdn.example/static-qr.png",
    );
    expect(screen.getByText(strings.en.payment_scan_instruction)).toBeInTheDocument();
    expect(screen.queryByText(strings.en.payment_pay_now)).not.toBeInTheDocument();
  });

  it("does not show the notice when live destinations match the bill freeze", async () => {
    renderPanel();
    await waitFor(() => {
      expect(mockFrom).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("test-panel-payment-details-updated")).not.toBeInTheDocument();
    expect(screen.getByTestId("test-panel-upi-id")).toHaveTextContent("shop@upi");
  });
});
