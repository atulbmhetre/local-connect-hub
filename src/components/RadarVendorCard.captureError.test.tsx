import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RadarVendorCard } from "@/components/RadarVendorCard";
import { strings } from "@/lib/strings";

const { mockRpc, captureErrorMock } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: captureErrorMock }));

function chainable() {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const key of [
    "select",
    "eq",
    "neq",
    "in",
    "is",
    "order",
    "limit",
    "gte",
    "lte",
    "or",
  ]) {
    api[key] = vi.fn(self);
  }
  api.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  api.single = vi.fn(async () => ({ data: { is_active: true }, error: null }));
  (api as { then?: unknown }).then = (
    resolve: (v: { data: unknown; error: null }) => unknown,
  ) => Promise.resolve({ data: [], error: null }).then(resolve);
  return api;
}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mockRpc,
    from: vi.fn(() => chainable()),
  },
  useCategoryLabel: () => (cat: string) => cat || "Vendor",
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
  migrateUserPhone: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/withNetworkRetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/withNetworkRetry")>();
  return {
    ...actual,
    withNetworkRetry: async <T,>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast: vi.fn(),
  dismissNetworkRetryingToast: vi.fn(),
  showNetworkFailedToast: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@/components/ParchiSheet", () => ({
  ParchiSheet: () => null,
}));
vi.mock("@/components/AiBridgeSheet", () => ({
  AiBridgeSheet: () => null,
}));
vi.mock("@/components/PhoneEntrySheet", () => ({
  PhoneEntrySheet: () => null,
}));
vi.mock("@/components/TrustBadge", () => ({
  TrustBadge: () => null,
}));
vi.mock("@/components/TrustWarningBanner", () => ({
  TrustWarningBanner: () => null,
}));

const baseVendor = {
  id: "vendor-radar-1",
  shop_name: "Test Shop",
  phone: "9000000001",
  category: "Plumber",
  service_mode: "help",
  is_active: true,
  is_manual_verified: true,
  upi_verified: true,
  photo_selfie: "https://example.com/s.jpg",
  latitude: 18.5,
  longitude: 73.8,
  shop_photo_url: null,
  verification_status: "verified",
  total_helped: 0,
  total_delivered: 0,
  rating: 5,
  rating_count: 1,
  serves_at_vendor_place: true,
  serves_at_customer_place: true,
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    vendor: baseVendor,
    isSaved: false,
    hasOrdered: false,
    hasFulfilledOrder: false,
    menuItems: [],
    categories: [
      {
        category_id: "cat-1",
        label: "Plumber",
        emoji: "🔧",
        brand_name: "Test Shop",
        is_manual_verified: true,
        shop_photo_url: null,
        verification_status: "verified",
      },
    ],
    trustLevel: "high" as const,
    dist: 1.2,
    index: 0,
    userNeed: "plumber",
    ...overrides,
  };
}

describe("RadarVendorCard captureError wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_saved_vendors_count") {
        return { data: 0, error: null };
      }
      return { data: null, error: null };
    });
  });

  it("captureError on save_saved_vendor failure", async () => {
    const saveErr = { message: "save failed", code: "P0001" };
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_saved_vendors_count") return { data: 0, error: null };
      if (name === "save_saved_vendor") return { data: null, error: saveErr };
      return { data: null, error: null };
    });

    render(<RadarVendorCard {...(baseProps() as unknown as Parameters<typeof RadarVendorCard>[0])} />);
    fireEvent.click(
      screen.getByRole("button", { name: /Save as My Plumber/i }),
    );
    fireEvent.click(screen.getByTestId("radar-save-nickname-confirm"));

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        saveErr,
        expect.objectContaining({
          scope: "radarVendorCard.saveSavedVendor",
          vendorId: "vendor-radar-1",
        }),
      );
    });
  });

  it("captureError on unsave_saved_vendor failure", async () => {
    const unsaveErr = { message: "unsave failed", code: "P0001" };
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "unsave_saved_vendor") return { data: null, error: unsaveErr };
      return { data: null, error: null };
    });

    render(
      <RadarVendorCard
        {...(baseProps({ isSaved: true }) as unknown as Parameters<typeof RadarVendorCard>[0])}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.en.neighbours_saved_button }));
    fireEvent.click(
      screen.getByRole("button", { name: strings.en.removeFromNeighbourhood }),
    );

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        unsaveErr,
        expect.objectContaining({
          scope: "radarVendorCard.unsaveSavedVendor",
          vendorId: "vendor-radar-1",
        }),
      );
    });
  });

  it("captureError on resolution RPC failure", async () => {
    const resErr = { message: "increment failed", code: "P0001" };
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "increment_vendor_helped") return { data: null, error: resErr };
      return { data: null, error: null };
    });

    render(
      <RadarVendorCard
        {...(baseProps({
          hasFulfilledOrder: true,
          fulfilledRequestId: null,
        }) as unknown as Parameters<typeof RadarVendorCard>[0])}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(strings.en.radar_vendor_helped, "i") }),
    );

    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        resErr,
        expect.objectContaining({
          scope: "radarVendorCard.resolution",
          vendorId: "vendor-radar-1",
          rpc: "increment_vendor_helped",
        }),
      );
    });
  });
});
