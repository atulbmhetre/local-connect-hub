import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

const s = strings.en;

const mockInvokeInitiateCall = vi.fn();
const mockConfig = vi.hoisted(() => ({
  exotelSecureCallingEnabled: false,
}));

const vendorRow: Vendor = {
  id: "vendor-track-1",
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
};

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
          maybeSingle: async () => ({ data: vendorRow, error: null }),
        }),
      }),
    }),
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
  invokeInitiateCall: (...args: unknown[]) => mockInvokeInitiateCall(...args),
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
  useAppConfig: () => ({ config: mockConfig, loading: false }),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876500099",
}));

vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() });
  return { toast };
});

vi.mock("@/components/VerificationBadge", () => ({
  VerificationBadge: () => null,
  vendorTier: () => "yellow" as const,
}));

vi.mock("@/components/TrustWarningBanner", () => ({
  TrustWarningBanner: () => null,
}));

import LiveTracking from "@/pages/LiveTracking";
import { toast } from "sonner";

function renderTrack() {
  return render(
    <MemoryRouter initialEntries={[`/track/${vendorRow.id}`]}>
      <Routes>
        <Route path="/track/:vendorId" element={<LiveTracking />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LiveTracking secure call honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.exotelSecureCallingEnabled = false;
    mockInvokeInitiateCall.mockResolvedValue({ success: true, call_sid: "CA_OK" });
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("with exotel_secure_calling_enabled=false shows coming soon and never opens the call modal", async () => {
    renderTrack();

    const cta = await screen.findByRole("button", { name: s.secure_call_coming_soon });
    expect(cta).toBeDisabled();

    await fireEvent.click(cta);

    expect(mockInvokeInitiateCall).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(s.secure_call_connected, expect.anything());
    expect(screen.queryByRole("button", { name: /End Call/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/AI-Bridge · Secure/i)).not.toBeInTheDocument();
  });

  it("with flag true and initiate success: connecting first, then connected modal after resolve", async () => {
    mockConfig.exotelSecureCallingEnabled = true;

    let resolveCall!: (value: { success: boolean; call_sid?: string }) => void;
    mockInvokeInitiateCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );

    renderTrack();

    const cta = await screen.findByRole("button", { name: s.secure_call_cta });
    await fireEvent.click(cta);

    // CTA label + connecting overlay both show this copy while the request is in flight.
    await waitFor(() => {
      expect(screen.getAllByText(s.secure_call_connecting).length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByRole("button", { name: /End Call/i })).not.toBeInTheDocument();
    expect(toast).not.toHaveBeenCalledWith(s.secure_call_connected, expect.anything());

    await act(async () => {
      resolveCall({ success: true, call_sid: "CA_OK" });
    });

    expect(await screen.findByRole("button", { name: /End Call/i })).toBeInTheDocument();
    expect(screen.getByText(/AI-Bridge · Secure/i)).toBeInTheDocument();
    expect(screen.getByText(/00:0/)).toBeInTheDocument();
    await waitFor(() => {
      expect(toast).toHaveBeenCalledWith(
        s.secure_call_connected,
        expect.objectContaining({
          description: s.secure_call_connected_body.replace("{name}", "Track Vendor"),
        }),
      );
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByText(s.secure_call_connecting)).not.toBeInTheDocument();
  });

  it("with flag true and initiate failure: confirm dialog before tel:, no silent dial", async () => {
    mockConfig.exotelSecureCallingEnabled = true;
    mockInvokeInitiateCall.mockResolvedValue({ success: false, error: "exotel_down" });

    renderTrack();

    const cta = await screen.findByRole("button", { name: s.secure_call_cta });
    await fireEvent.click(cta);

    expect(await screen.findByText(s.secure_call_failed_title)).toBeInTheDocument();
    expect(
      screen.getByText(s.secure_call_failed_body.replace("{name}", "Track Vendor")),
    ).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /End Call/i })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("button", { name: s.secure_call_call_directly }));

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith("tel:9876500002", "_self");
    });
  });
});
