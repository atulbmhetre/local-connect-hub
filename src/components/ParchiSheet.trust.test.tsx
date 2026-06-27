import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ParchiSheet } from "@/components/ParchiSheet";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

window.scrollTo = vi.fn();
Element.prototype.scrollTo = vi.fn();

const mockFetchUserTrust = vi.fn();
const mockInsert = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      insert: mockInsert.mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: { id: "order-1" }, error: null }),
        }),
      }),
    })),
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
  verification_status: "pending",
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

describe("ParchiSheet trust flows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchUserTrust.mockResolvedValue({
      trust_score: 35,
      is_banned: false,
      total_orders: 5,
    });
  });

  it("low-trust flow requires checkbox before confirm is enabled", async () => {
    render(
      <ParchiSheet vendor={vendor} isOpen onClose={() => {}} />,
    );

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Need groceries" },
    });
    fireEvent.change(screen.getByTestId("parchi-address-input"), {
      target: { value: "12 Test Street" },
    });
    fireEvent.click(screen.getByTestId("parchi-submit-btn"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.parchi_trust_low_title)).toBeInTheDocument();
    });

    const confirmBtn = screen.getByTestId("parchi-low-trust-confirm");
    expect(confirmBtn).toBeDisabled();

    fireEvent.click(screen.getByTestId("parchi-low-trust-checkbox"));
    expect(confirmBtn).not.toBeDisabled();
  });

  it("medium-trust flow shows confirm dialog and places order on confirm", async () => {
    mockFetchUserTrust.mockResolvedValue({
      trust_score: 60,
      is_banned: false,
      total_orders: 5,
    });

    render(
      <ParchiSheet vendor={vendor} isOpen onClose={() => {}} />,
    );

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Need groceries" },
    });
    fireEvent.change(screen.getByTestId("parchi-address-input"), {
      target: { value: "12 Test Street" },
    });
    fireEvent.click(screen.getByTestId("parchi-submit-btn"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.parchi_trust_medium_title)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("parchi-medium-trust-confirm"));

    await waitFor(() => {
      expect(mockInsert).toHaveBeenCalled();
    });
  });
});
