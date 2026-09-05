import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ParchiSheet } from "@/components/ParchiSheet";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

window.scrollTo = vi.fn();
Element.prototype.scrollTo = vi.fn();

const mockFetchUserTrust = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: (...args: unknown[]) => mockRpc(...args),
  },
  fetchUserTrust: (...args: unknown[]) => mockFetchUserTrust(...args),
  invokeNotifyVendor: vi.fn(),
  upsertUser: vi.fn(),
  incrementUserOrders: vi.fn(),
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "test",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: { maxOrderMessageChars: 500, helpAcceptTimeoutHours: 2 },
    loading: false,
  }),
}));

vi.mock("@/hooks/useUserAddresses", () => ({
  useUserAddresses: () => ({ addresses: [], loading: false }),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
  isPhoneKnown: () => true,
  migrateUserPhone: vi.fn(),
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "device-test",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/hooks/useNetworkStatus", () => ({
  getNavigatorOnline: () => true,
}));

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast: vi.fn(),
  showNetworkFailedToast: vi.fn(),
  dismissNetworkRetryingToast: vi.fn(),
}));

const vendor = {
  id: "vendor-1",
  name: "Test",
  shop_name: "Test Shop",
  category: "Grocery",
  upi_id: "test@upi",
  phone: "9999999999",
  is_active: true,
  latitude: 18.5,
  longitude: 73.8,
  verification_status: "unverified",
  shop_photo_url: null,
  upi_verified: false,
  is_manual_verified: false,
  created_at: new Date().toISOString(),
  service_mode: "delivery",
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  service_radius_km: 15,
} as Vendor;

describe("ParchiSheet Send sync lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUserTrust.mockResolvedValue({
      trust_score: 90,
      is_banned: false,
      total_orders: 5,
    });
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_customer_payment_block_status") {
        return { data: [{ is_blocked: false }], error: null };
      }
      if (name === "create_customer_request") {
        return { data: "order-1", error: null };
      }
      return { data: null, error: null };
    });
  });

  it("rapid double-tap on Send calls create_customer_request only once", async () => {
    let resolvePlace: (() => void) | undefined;
    const placeGate = new Promise<void>((resolve) => {
      resolvePlace = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_customer_payment_block_status") {
        return { data: [{ is_blocked: false }], error: null };
      }
      if (name === "create_customer_request") {
        await placeGate;
        return { data: "order-1", error: null };
      }
      return { data: null, error: null };
    });

    render(
      <MemoryRouter>
        <ParchiSheet vendor={vendor} isOpen onClose={() => {}} />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Need groceries" },
    });
    fireEvent.change(screen.getByTestId("parchi-address-input"), {
      target: { value: "12 Test Street" },
    });

    const sendBtn = screen.getByTestId("parchi-submit-btn");
    fireEvent.click(sendBtn);
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "create_customer_request"),
      ).toHaveLength(1);
    });

    resolvePlace?.();
    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "create_customer_request"),
      ).toHaveLength(1);
    });
  });
});
