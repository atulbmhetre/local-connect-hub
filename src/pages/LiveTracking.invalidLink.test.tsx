import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { strings } from "@/lib/strings";

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({
    config: { exotelSecureCallingEnabled: false },
    loading: false,
  }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: [], error: null })),
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    })),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  },
  invokeInitiateCall: vi.fn(),
  useCategoryLabel: () => (label: string) => label,
  distanceKm: () => 0,
}));

vi.mock("@/lib/vendorRead", () => ({
  fetchVendorsVisibleToCustomer: vi.fn(async () => ({ data: [], error: null })),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "device" }));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => null }));
vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));
vi.mock("@/lib/businessPhotoFallback", () => ({
  fetchBusinessPhotos: vi.fn(async () => new Map()),
  resolveVendorPhoto: () => null,
}));
vi.mock("@/components/VerificationBadge", () => ({ vendorTier: () => "none" }));
vi.mock("@/components/TrustBadge", () => ({ TrustBadge: () => null }));
vi.mock("@/components/TrustWarningBanner", () => ({ TrustWarningBanner: () => null }));
vi.mock("@/components/SecureCallPreDialOverlay", () => ({
  SecureCallPreDialOverlay: () => null,
}));
vi.mock("react-leaflet", () => ({
  MapContainer: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  TileLayer: () => null,
  Marker: () => null,
  Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn() }),
}));

import LiveTracking from "@/pages/LiveTracking";

describe("LiveTracking missing vendorId (M8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows invalid-link state instead of spinning forever", async () => {
    render(
      <MemoryRouter initialEntries={["/tracking"]}>
        <Routes>
          <Route path="/tracking" element={<LiveTracking />} />
          <Route path="/tracking/:vendorId" element={<LiveTracking />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(strings.en.liveTracking_invalidLink)).toBeInTheDocument();
    });
    expect(screen.queryByText(strings.en.liveTracking_opening)).not.toBeInTheDocument();
  });
});
