import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RatingSheet } from "@/components/RatingSheet";
import { strings } from "@/lib/strings";

const { mockRpc, mockMaybeSingle, captureError } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockMaybeSingle: vi.fn(),
  captureError: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mockRpc,
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle,
    })),
  },
  invokeNotifyVendor: vi.fn(),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/vendorRating", () => ({
  syncVendorRatingFromReviews: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {},
}));

function renderSheet(onDismiss: () => void) {
  return render(
    <RatingSheet
      isOpen
      shopName="Test Shop"
      serviceMode="delivery"
      vendorId="vendor-1"
      vendorPhone="9000000000"
      requestId="req-1"
      onDismiss={onDismiss}
    />,
  );
}

async function pickStarsAndSubmit() {
  fireEvent.click(screen.getByTestId("rating-star-5"));
  fireEvent.click(screen.getByTestId("rating-submit-btn"));
}

describe("RatingSheet failed submission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No pre-existing review for the order.
    mockMaybeSingle.mockResolvedValue({ data: null, error: null });
  });

  it("does NOT call onDismiss when submit_vendor_review fails; retry stays possible", async () => {
    const onDismiss = vi.fn();
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "submit_vendor_review") {
        return { data: null, error: { message: "network timeout" } };
      }
      return { data: null, error: null };
    });

    renderSheet(onDismiss);
    await pickStarsAndSubmit();

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "submit_vendor_review",
        expect.objectContaining({ p_request_id: "req-1" }),
      );
    });

    // Failure must not archive the order (onDismiss triggers markDone in MyOrders).
    expect(onDismiss).not.toHaveBeenCalled();
    expect(captureError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "ratingSheet.submitVendorReview" }),
    );

    // The sheet is still usable: submit button re-enabled for retry.
    await waitFor(() => {
      expect(screen.getByTestId("rating-submit-btn")).toBeEnabled();
    });

    // Retry with the backend recovered — now the dismiss path fires.
    mockRpc.mockImplementation(async () => ({ data: null, error: null }));
    fireEvent.click(screen.getByTestId("rating-submit-btn"));
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("still calls onDismiss on a successful submission", async () => {
    const onDismiss = vi.fn();
    mockRpc.mockResolvedValue({ data: null, error: null });

    renderSheet(onDismiss);
    await pickStarsAndSubmit();

    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("still calls onDismiss on deliberate Skip (confirmed RV-04 behavior)", async () => {
    const onDismiss = vi.fn();
    mockRpc.mockResolvedValue({ data: null, error: null });

    renderSheet(onDismiss);
    fireEvent.click(screen.getByTestId("rating-skip-btn"));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("rapid double-tap on submit calls submit_vendor_review only once", async () => {
    const onDismiss = vi.fn();
    let resolveSubmit: (() => void) | undefined;
    const submitGate = new Promise<void>((resolve) => {
      resolveSubmit = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "submit_vendor_review") {
        await submitGate;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });

    renderSheet(onDismiss);
    fireEvent.click(screen.getByTestId("rating-star-5"));
    const submitBtn = screen.getByTestId("rating-submit-btn");
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "submit_vendor_review"),
      ).toHaveLength(1);
    });

    resolveSubmit?.();
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
