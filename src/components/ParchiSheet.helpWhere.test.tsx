import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ParchiSheet } from "@/components/ParchiSheet";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

window.scrollTo = vi.fn();
Element.prototype.scrollTo = vi.fn();

const mockFetchUserTrust = vi.fn();
const mockRpc = vi.fn();
const mockToastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
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

const baseVendor = {
  id: "vendor-1",
  name: "Mechanic",
  shop_name: "SAM mechanic",
  category: "Mechanic",
  upi_id: "test@upi",
  phone: "8888169446",
  is_active: true,
  latitude: 18.5,
  longitude: 73.8,
  verification_status: "business_verified",
  shop_photo_url: null,
  upi_verified: false,
  is_manual_verified: false,
  created_at: new Date().toISOString(),
  service_mode: "help",
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  service_radius_km: 15,
  serves_at_vendor_place: true,
  serves_at_customer_place: true,
} as Vendor;

describe("ParchiSheet Help reach choice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: "order-1", error: null });
    mockFetchUserTrust.mockResolvedValue({
      trust_score: 90,
      is_banned: false,
      total_orders: 5,
    });
  });

  it("blocks submit when both reach options exist and no choice is made", async () => {
    render(<ParchiSheet vendor={baseVendor} isOpen onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Need help with bike" },
    });
    fireEvent.click(screen.getByTestId("parchi-submit-btn"));

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(strings.en.parchi_errHelpWhereRequired);
    });
    expect(mockRpc).not.toHaveBeenCalledWith("create_customer_request", expect.anything());
  });

  it("passes p_service_location when customer picks come-to-me", async () => {
    render(<ParchiSheet vendor={baseVendor} isOpen onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Need help with bike" },
    });
    fireEvent.click(screen.getByTestId("parchi-help-come-to-me"));
    fireEvent.click(screen.getByTestId("parchi-submit-btn"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "create_customer_request",
        expect.objectContaining({
          p_service_location: "customer_place",
          p_service_mode: "help",
        }),
      );
    });
  });

  it("auto-sets vendor_place when vendor only serves at their place", async () => {
    const shopOnly = {
      ...baseVendor,
      serves_at_customer_place: false,
      serves_at_vendor_place: true,
    } as Vendor;

    render(<ParchiSheet vendor={shopOnly} isOpen onClose={() => {}} />);

    fireEvent.change(screen.getByTestId("parchi-message-input"), {
      target: { value: "Visit shop for repair" },
    });
    fireEvent.click(screen.getByTestId("parchi-submit-btn"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "create_customer_request",
        expect.objectContaining({
          p_service_location: "vendor_place",
        }),
      );
    });
    expect(screen.queryByTestId("parchi-help-come-to-me")).toBeNull();
  });
});
