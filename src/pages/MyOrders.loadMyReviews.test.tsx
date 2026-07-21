import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MyOrders from "@/pages/MyOrders";
import { strings } from "@/lib/strings";

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: mocks.captureError }));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    loading: vi.fn(() => "toast-id"),
    dismiss: vi.fn(),
  },
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: {
      maxOrderMessageChars: 500,
      helpAcceptTimeoutHours: 5,
      vendorStoppedMinutes: 15,
      vendorStoppedDistanceMeters: 50,
    },
    loading: false,
  }),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9876543210" }));
vi.mock("@/lib/voiceUtils", () => ({ getVoiceLang: () => "en-IN" }));
vi.mock("@/lib/vendorRead", () => ({ fetchVendorsVisibleToCustomer: vi.fn() }));
vi.mock("@/lib/vendorRating", () => ({
  syncVendorRatingFromReviews: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {},
}));

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/RatingSheet", () => ({ RatingSheet: () => null }));
vi.mock("@/components/PaymentSheet", () => ({ PaymentSheet: () => null }));
vi.mock("@/components/AiBridgeSheet", () => ({ AiBridgeSheet: () => null }));
vi.mock("@/components/BillEditHistorySheet", () => ({ BillEditHistorySheet: () => null }));
vi.mock("@/components/settings/SettingsSection", () => ({
  SettingsPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsSectionLabel: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({}),
    })),
    removeChannel: vi.fn(),
  },
  invokeNotifyVendor: vi.fn(),
  distanceMeters: () => 0,
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "test-anon",
}));

const ORDER_ROW = {
  id: "req-1",
  device_id: "test-device",
  vendor_id: "vendor-1",
  message: "2kg atta",
  status: "done",
  created_at: new Date().toISOString(),
  user_phone: "9876543210",
  payment_status: "paid",
  vendor_shop_name: "Test Shop",
  vendor_service_mode: "delivery",
  vendor_phone: "9000000000",
  vendor_latitude: null,
  vendor_longitude: null,
};

const REVIEW_ROW = {
  id: "rev-1",
  request_id: "req-1",
  rating: 4,
  review_text: "Great service",
  created_at: new Date().toISOString(),
  vendor_response: null,
  vendor_responded_at: null,
};

/** get_my_orders is awaited via .retry(false); other RPCs are awaited directly. */
function rpcResult<T>(result: T) {
  const promise = Promise.resolve(result);
  return Object.assign(promise, { retry: () => Promise.resolve(result) });
}

let reviewsResult: { data: typeof REVIEW_ROW[] | null; error: { message: string } | null };

describe("MyOrders loadMyReviews failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    reviewsResult = { data: [REVIEW_ROW], error: null };

    mocks.rpc.mockImplementation((name: string) => {
      if (name === "get_my_orders") return rpcResult({ data: [ORDER_ROW], error: null });
      return rpcResult({ data: [], error: null });
    });
    mocks.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      or: vi.fn(() => Promise.resolve(reviewsResult)),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves the last-good reviews and captures the error when the reviews query fails on refresh", async () => {
    render(
      <MemoryRouter initialEntries={["/my-orders"]}>
        <MyOrders />
      </MemoryRouter>,
    );

    // First load succeeds: the saved review is shown on the done order.
    expect(await screen.findByText(/Great service/)).toBeInTheDocument();

    // Next 30s poll: the vendor_reviews query now fails.
    reviewsResult = { data: null, error: { message: "reviews fetch failed" } };
    await vi.advanceTimersByTimeAsync(30_000);

    await waitFor(() => {
      expect(mocks.captureError).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ scope: "myOrders.loadMyReviews" }),
      );
    });
    expect(mocks.toastError).toHaveBeenCalledWith(strings.en.myOrders_reviewsLoadError, {
      id: "myorders-reviews-load-error",
    });

    // Last-good state preserved: the review block did not blank out, so the
    // order still reads as rated instead of re-showing the Rate CTA.
    expect(screen.getByText(/Great service/)).toBeInTheDocument();
  });

  it("still replaces the map on a successful refresh", async () => {
    render(
      <MemoryRouter initialEntries={["/my-orders"]}>
        <MyOrders />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Great service/)).toBeInTheDocument();

    // Successful (even changed) results must still apply.
    reviewsResult = {
      data: [{ ...REVIEW_ROW, review_text: "Updated review text" }],
      error: null,
    };
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await screen.findByText(/Updated review text/)).toBeInTheDocument();
    expect(mocks.captureError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: "myOrders.loadMyReviews" }),
    );
  });
});
