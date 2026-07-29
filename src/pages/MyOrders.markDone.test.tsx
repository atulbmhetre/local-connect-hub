import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MyOrders from "@/pages/MyOrders";
import { strings } from "@/lib/strings";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  invokeNotifyVendor: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() },
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: { maxOrderMessageChars: 500, helpAcceptTimeoutHours: 5, vendorStoppedMinutes: 15, vendorStoppedDistanceMeters: 50 },
    loading: false,
  }),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9876543210" }));
vi.mock("@/lib/voiceUtils", () => ({ getVoiceLang: () => "en-IN" }));
vi.mock("@/lib/vendorRead", () => ({ fetchVendorsVisibleToCustomer: vi.fn() }));
vi.mock("@/lib/vendorRating", () => ({ syncVendorRatingFromReviews: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@capacitor-community/speech-recognition", () => ({ SpeechRecognition: {} }));
vi.mock("@/components/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
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
    channel: vi.fn(() => ({ on: vi.fn().mockReturnThis(), subscribe: vi.fn() })),
    removeChannel: vi.fn(),
  },
  invokeNotifyVendor: mocks.invokeNotifyVendor,
  distanceMeters: () => 0,
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "test-anon",
}));

const CANCELLED_ORDER = {
  id: "req-cancelled-1",
  device_id: "test-device",
  vendor_id: "vendor-1",
  message: "Cancelled order",
  status: "cancelled",
  created_at: new Date().toISOString(),
  user_phone: "9876543210",
  payment_status: "paid",
  vendor_shop_name: "Test Shop",
  vendor_service_mode: "delivery",
  vendor_phone: "9000000000",
  vendor_latitude: null,
  vendor_longitude: null,
};

function rpcResult<T>(result: T) {
  const promise = Promise.resolve(result);
  return Object.assign(promise, { retry: () => Promise.resolve(result) });
}

describe("MyOrders markDone submit lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.from.mockImplementation(() => ({
      select: vi.fn().mockReturnThis(),
      or: vi.fn(() => Promise.resolve({ data: [], error: null })),
    }));
    mocks.rpc.mockImplementation((name: string) => {
      if (name === "get_my_orders") return rpcResult({ data: [CANCELLED_ORDER], error: null });
      return rpcResult({ data: null, error: null });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rapid double-tap on dismiss calls dismiss_order only once", async () => {
    let resolveDismiss: (() => void) | undefined;
    const dismissGate = new Promise<void>((resolve) => {
      resolveDismiss = resolve;
    });

    mocks.rpc.mockImplementation((name: string) => {
      if (name === "get_my_orders") return rpcResult({ data: [CANCELLED_ORDER], error: null });
      if (name === "dismiss_order") {
        return rpcResult(dismissGate.then(() => ({ data: null, error: null })));
      }
      return rpcResult({ data: null, error: null });
    });

    render(
      <MemoryRouter initialEntries={["/my-orders"]}>
        <MyOrders />
      </MemoryRouter>,
    );

    const dismissBtn = await screen.findByTestId("order-dismiss-btn");
    fireEvent.click(dismissBtn);
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(mocks.rpc.mock.calls.filter((call) => call[0] === "dismiss_order")).toHaveLength(1);
    });

    resolveDismiss?.();
    await waitFor(() => {
      expect(screen.queryByTestId("order-dismiss-btn")).not.toBeInTheDocument();
    });
  });
});
