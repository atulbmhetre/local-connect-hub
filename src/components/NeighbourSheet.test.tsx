import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NeighbourSheet } from "@/components/NeighbourSheet";
import { strings } from "@/lib/strings";
import { markNeighboursDirty } from "@/lib/savedVendors";

const { mockRpc, mockFrom, captureErrorMock } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: captureErrorMock }));
vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc, from: mockFrom },
  useCategoryLabel: () => (cat: string) => (cat === "Plumber" ? "Plumber (L)" : cat),
  emojiForVendorCategory: () => "🔧",
}));
vi.mock("@/components/RadarVendorCard", () => ({
  RadarVendorCard: ({
    categories,
    vendor,
  }: {
    categories: { label: string; category_id?: string }[];
    vendor: { upi_id?: string };
  }) => (
    <div data-testid="radar-vendor-card">
      {categories[0]?.label} {vendor.upi_id}
    </div>
  ),
}));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9876543210" }));
vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "test-device" }));
vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));
vi.mock("@/lib/withNetworkRetry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/withNetworkRetry")>();
  return { ...actual, withNetworkRetry: async <T,>(fn: () => Promise<T>) => fn() };
});
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast: vi.fn(),
  dismissNetworkRetryingToast: vi.fn(),
  showNetworkFailedToast: vi.fn(),
}));

const vendor = {
  id: "v1",
  shop_name: "Real Shop",
  phone: "9000000001",
  category: "Plumber",
  service_mode: "help",
  is_active: true,
  shop_photo_url: null,
} as never;

describe("NeighbourSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    });
  });

  it("shows nickname when set, localized category, and shop name subtitle", () => {
    render(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "My guy", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={() => {}}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );
    expect(screen.getByText("My guy")).toBeTruthy();
    expect(screen.getByText("Real Shop")).toBeTruthy();
    expect(screen.getByText("Plumber (L)")).toBeTruthy();
  });

  it("falls back to shop name when nickname empty", () => {
    render(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={() => {}}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );
    expect(screen.getByText("Real Shop")).toBeTruthy();
  });

  it("captureError + markNeighboursDirty on unsave failure / success", async () => {
    const unsaveErr = { message: "boom", code: "P0001" };
    mockRpc.mockResolvedValueOnce({ data: null, error: unsaveErr });

    const onRemove = vi.fn();
    const { rerender } = render(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={onRemove}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );

    fireEvent.click(screen.getByText(strings.en.removeFromNeighbourhood));
    await waitFor(() => {
      expect(captureErrorMock).toHaveBeenCalledWith(
        unsaveErr,
        expect.objectContaining({ scope: "neighbourSheet.unsaveSavedVendor" }),
      );
    });
    expect(onRemove).not.toHaveBeenCalled();

    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    rerender(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={onRemove}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );
    fireEvent.click(screen.getByText(strings.en.removeFromNeighbourhood));
    await waitFor(() => expect(onRemove).toHaveBeenCalled());
    expect(localStorage.getItem("aaspaas:neighbours_dirty")).toBe("true");
    // markNeighboursDirty is the same helper Radar uses
    expect(typeof markNeighboursDirty).toBe("function");
  });

  it("set / clear nickname via update_saved_vendor_nickname", async () => {
    const onNicknameChanged = vi.fn();
    mockRpc.mockResolvedValue({ data: null, error: null });

    render(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={() => {}}
        onNicknameChanged={onNicknameChanged}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("neighbour-nickname-edit-btn"));
    fireEvent.change(screen.getByTestId("neighbour-nickname-input"), {
      target: { value: "Corner shop" },
    });
    fireEvent.click(screen.getByTestId("neighbour-nickname-save-btn"));

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "update_saved_vendor_nickname",
        expect.objectContaining({
          p_vendor_id: "v1",
          p_nickname: "Corner shop",
        }),
      );
      expect(onNicknameChanged).toHaveBeenCalledWith("Corner shop");
    });

    fireEvent.click(screen.getByTestId("neighbour-nickname-edit-btn"));
    fireEvent.click(screen.getByTestId("neighbour-nickname-clear-btn"));
    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith(
        "update_saved_vendor_nickname",
        expect.objectContaining({ p_nickname: "" }),
      );
      expect(onNicknameChanged).toHaveBeenCalledWith("");
    });
  });

  it("renders one Radar card per saved-neighbour business (#8)", async () => {
    mockFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () =>
            Promise.resolve({
              data: [
                {
                  category_id: "mechanic",
                  brand_name: "Ramesh Mechanic",
                  service_mode: "help",
                  upi_id: "mech@upi",
                  latitude: 18.1,
                  longitude: 73.2,
                  categories: { label: "Mechanic", emoji: "🔧" },
                },
                {
                  category_id: "nursery",
                  brand_name: "Ramesh Nursery",
                  service_mode: "delivery",
                  upi_id: "plants@upi",
                  latitude: 18.4,
                  longitude: 73.9,
                  categories: { label: "Nursery", emoji: "🌱" },
                },
              ],
              error: null,
            }),
        }),
      }),
    });
    render(
      <NeighbourSheet
        vendor={vendor}
        savedVendor={{ nickname: "Ramesh", category: "Plumber" }}
        isOpen
        onClose={() => {}}
        onRemove={() => {}}
        activeDeliveryOrder={false}
        activeAppointmentOrder={false}
        categories={[]}
        onOpenParchi={() => {}}
        onOpenAiBridge={() => {}}
        onNavigateOrders={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("neighbour-business-card")).toHaveLength(2);
    });
    expect(screen.getByText(/Mechanic/)).toBeTruthy();
    expect(screen.getByText(/Nursery/)).toBeTruthy();
    expect(screen.getByText(/mech@upi/)).toBeTruthy();
    expect(screen.getByText(/plants@upi/)).toBeTruthy();
  });
});
