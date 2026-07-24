import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { RadarVendorCard } from "@/components/RadarVendorCard";
import { strings } from "@/lib/strings";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

function chainable() {
  const api: Record<string, unknown> = {};
  const self = () => api;
  for (const key of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "or"]) {
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
  supabase: { rpc: vi.fn(async () => ({ data: 0, error: null })), from: vi.fn(() => chainable()) },
  useCategoryLabel: () => (cat: string) => cat || "Vendor",
}));
vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
  migrateUserPhone: vi.fn(),
}));
vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "test-device" }));
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
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock("@/components/ParchiSheet", () => ({ ParchiSheet: () => null }));
vi.mock("@/components/AiBridgeSheet", () => ({ AiBridgeSheet: () => null }));
vi.mock("@/components/PhoneEntrySheet", () => ({ PhoneEntrySheet: () => null }));
vi.mock("@/components/TrustBadge", () => ({ TrustBadge: () => null }));
vi.mock("@/components/TrustWarningBanner", () => ({ TrustWarningBanner: () => null }));

const langMock = vi.hoisted(() => ({
  current: "en" as "en" | "hi" | "mr",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    get s() {
      return strings[langMock.current];
    },
    lang: langMock.current,
    setLang: () => {},
  }),
}));

const vendorComplete = {
  id: "v-green",
  shop_name: "Green Shop",
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

function renderCard(
  vendorOverrides: Record<string, unknown> = {},
  own = false,
) {
  const vendor = { ...vendorComplete, ...vendorOverrides };
  if (own) {
    localStorage.setItem("aaspaas:vendor_id", vendor.id);
    localStorage.setItem("aaspaas:user_phone", "9000000001");
  } else {
    localStorage.removeItem("aaspaas:vendor_id");
  }
  const props = {
    vendor,
    isSaved: false,
    hasOrdered: false,
    hasFulfilledOrder: false,
    menuItems: [] as { name: string; price: number; unit: string | null; is_available: boolean }[],
    categories: [
      {
        category_id: "cat-1",
        label: "Plumber",
        emoji: "🔧",
        brand_name: vendor.shop_name as string,
        is_manual_verified: vendor.is_manual_verified as boolean | null,
        shop_photo_url: null as string | null,
        verification_status: "verified" as string | null,
      },
    ],
    trustLevel: "high" as const,
    dist: 1.2,
    index: 0,
    userNeed: "plumber",
  };
  return render(
    <RadarVendorCard {...(props as unknown as Parameters<typeof RadarVendorCard>[0])} />,
  );
}

describe("RadarVendorCard accent + i18n render", () => {
  it("accent ring is brand only when vendorBinaryTrustTier is green", () => {
    langMock.current = "en";
    const { container, unmount } = renderCard();
    const card = container.querySelector('[data-testid="radar-vendor-card"]');
    expect(vendorBinaryTrustTier(vendorComplete)).toBe("green");
    expect(card?.className).toContain("ring-brand/50");
    unmount();

    const { container: c2 } = renderCard({ is_manual_verified: false });
    const card2 = c2.querySelector('[data-testid="radar-vendor-card"]');
    expect(vendorBinaryTrustTier({ ...vendorComplete, is_manual_verified: false })).toBe("red");
    expect(card2?.className).toContain("ring-destructive/30");
    expect(card2?.className).not.toContain("ring-brand/50");
  });

  it.each([
    ["en", "Online", "• You"],
    ["hi", "ऑनलाइन", "• आप"],
    ["mr", "ऑनलाइन", "• तुम्ही"],
  ] as const)("%s online aria + own-vendor label render", (lang, online, ownLabel) => {
    langMock.current = lang;
    localStorage.clear();
    const { unmount } = renderCard({}, true);
    expect(screen.getByLabelText(online)).toBeTruthy();
    expect(screen.getByText(ownLabel)).toBeTruthy();
    unmount();
  });
});
