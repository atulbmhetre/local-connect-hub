import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

const s = strings.en;

const mockVendor = vi.hoisted(() => ({
  current: null as Vendor | null,
}));

function makeVendor(overrides: Partial<Vendor> = {}): Vendor {
  return {
    id: "vendor-track-pd-1",
    name: "Track Vendor",
    shop_name: "Track Shop",
    category: "Plumber",
    upi_id: "",
    phone: "9876500002",
    is_active: true,
    latitude: 18.52,
    longitude: 73.85,
    verification_status: "unverified",
    shop_photo_url: null,
    upi_verified: false,
    is_manual_verified: false,
    created_at: new Date().toISOString(),
    service_mode: "help",
    vendor_note: null,
    cancel_reason_1: null,
    cancel_reason_2: null,
    cancel_reason_3: null,
    cancel_reason_4: null,
    total_helped: 1,
    on_time_rate: 80,
    service_radius_km: 15,
    ...overrides,
  };
}

vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: unknown }) => (
    <div data-testid="map">{children as never}</div>
  ),
  TileLayer: () => null,
  Marker: () => null,
  Polyline: () => null,
  useMap: () => ({ fitBounds: () => undefined }),
}));

vi.mock("leaflet", () => ({
  default: {
    divIcon: () => ({}),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: () => ({}),
  },
}));

vi.mock("leaflet/dist/leaflet.css", () => ({}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: mockVendor.current, error: null }),
        }),
      }),
    }),
    rpc: async () => ({ data: mockVendor.current ? [mockVendor.current] : [], error: null }),
    channel: () => ({
      on() {
        return this;
      },
      subscribe() {
        return this;
      },
    }),
    removeChannel: vi.fn(),
  },
  invokeInitiateCall: vi.fn(),
  useCategoryLabel: () => (c: string) => c,
  distanceKm: () => 1.2,
}));

vi.mock("@/lib/withNetworkRetry", () => ({
  withNetworkRetry: async <T,>(fn: () => Promise<T>) => fn(),
  throwOnSupabaseNetworkError: <T,>(result: T) => result,
  NetworkExhaustedError: class NetworkExhaustedError extends Error {},
}));

vi.mock("@/hooks/useNetworkStatus", () => ({
  getNavigatorOnline: () => true,
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: { exotelSecureCallingEnabled: false },
    loading: false,
  }),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876500099",
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "device-pd-1",
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/components/VerificationBadge", () => ({
  VerificationBadge: () => null,
  vendorTier: (v: { is_manual_verified?: boolean | null; verification_status?: string | null }) => {
    if (v.is_manual_verified) return "green" as const;
    if (v.verification_status === "pending" || v.verification_status === "submitted") {
      return "yellow" as const;
    }
    return "red" as const;
  },
}));

vi.mock("@/components/TrustBadge", () => ({
  TrustBadge: ({ isManualVerified }: { isManualVerified?: boolean | null }) => (
    <span data-testid={isManualVerified === true ? "badge-verified" : "badge-unverified"}>
      {isManualVerified === true ? s.badge_verified : s.badge_unverified}
    </span>
  ),
}));

vi.mock("@/components/TrustWarningBanner", () => ({
  TrustWarningBanner: () => <div data-testid="trust-warning-banner-tracking" />,
}));

import LiveTracking from "@/pages/LiveTracking";

function renderTrack() {
  return render(
    <MemoryRouter initialEntries={[`/track/${mockVendor.current!.id}`]}>
      <Routes>
        <Route path="/track/:vendorId" element={<LiveTracking />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** RAD-09: TrustBadge is the sole verification-status signal; subtitle must not echo vendorTier. */
describe("LiveTracking progressive disclosure (RAD-09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("unverified: TrustBadge only — no legacy Unverified / pending / Verified Professional subtitle", async () => {
    mockVendor.current = makeVendor({
      is_manual_verified: false,
      verification_status: "unverified",
    });
    const { container } = renderTrack();

    expect(await screen.findByTestId("badge-unverified")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="badge-verified"]')).toBeNull();

    expect(screen.getByText(s.liveTracking_readyToHelp)).toBeInTheDocument();
    expect(screen.queryByText(s.vendor_verified_pro)).not.toBeInTheDocument();
    expect(screen.queryByText(s.liveTracking_pendingAdmin)).not.toBeInTheDocument();
    expect(
      screen.queryByText(`${s.settings_unverified} — ${s.liveTracking_callWithCare}`),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(s.liveTracking_callWithCare)).not.toBeInTheDocument();

    // Privacy/secure-connection strip is a separate always-on system (left intact).
    expect(screen.getByTestId("trust-warning-banner-tracking")).toBeInTheDocument();
  });

  it("verified: TrustBadge only — subtitle is ready-to-help without verification suffix", async () => {
    mockVendor.current = makeVendor({
      is_manual_verified: true,
      verification_status: "business_verified",
    });
    const { container } = renderTrack();

    expect(await screen.findByTestId("badge-verified")).toBeInTheDocument();
    expect(container.querySelector('[data-testid="badge-unverified"]')).toBeNull();

    expect(screen.getByText(s.liveTracking_readyToHelp)).toBeInTheDocument();
    expect(screen.queryByText(s.vendor_verified_pro)).not.toBeInTheDocument();
    expect(screen.queryByText(s.liveTracking_pendingAdmin)).not.toBeInTheDocument();
    expect(
      screen.queryByText(`${s.settings_unverified} — ${s.liveTracking_callWithCare}`),
    ).not.toBeInTheDocument();
  });
});
