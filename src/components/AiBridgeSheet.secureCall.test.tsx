import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { strings } from "@/lib/strings";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";

const s = strings.en;

const mockInvokeInitiateCall = vi.fn();
const mockBuildVendorBrief = vi.fn();
const mockConfig = vi.hoisted(() => ({
  exotelSecureCallingEnabled: false,
  helpCallLimitSeconds: 300,
  deliveryCallLimitSeconds: 120,
  appointmentCallLimitSeconds: 180,
}));

vi.mock("@/lib/supabase", () => ({
  invokeInitiateCall: (...args: unknown[]) => mockInvokeInitiateCall(...args),
  buildVendorBrief: (...args: unknown[]) => mockBuildVendorBrief(...args),
  emojiForVendorCategory: () => "🛒",
  useCategoryLabel: () => (c: string) => c,
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/hooks/useAppConfig", () => ({
  useAppConfig: () => ({ config: mockConfig, loading: false }),
}));

vi.mock("@/components/VerificationBadge", () => ({
  VerificationBadge: () => null,
  vendorTier: () => "yellow" as const,
  getVerificationCopy: () => ({
    green: { label: "Verified" },
    yellow: { label: "Pending" },
    red: { label: "Unverified" },
  }),
}));

vi.mock("@/components/TrustBadge", () => ({
  TrustBadge: () => null,
}));

vi.mock("@/components/TrustWarningBanner", () => ({
  TrustWarningBanner: () => null,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

const vendor: AiBridgeVendor = {
  id: "vendor-bridge-1",
  name: "Bridge Vendor",
  shop_name: "Bridge Shop",
  category: "Grocery",
  vendor_note: null,
  phone: "9876500001",
  service_mode: "help",
  verification_status: "unverified",
  is_manual_verified: false,
  total_helped: 3,
  on_time_rate: 90,
};

function renderSheet() {
  return render(
    <AiBridgeSheet
      open
      onClose={vi.fn()}
      vendor={vendor}
      callerPhone="9876500099"
      userNeed="help"
    />,
  );
}

describe("AiBridgeSheet secure call honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.exotelSecureCallingEnabled = false;
    mockBuildVendorBrief.mockResolvedValue({ ok: true, brief: "Test brief for call." });
    mockInvokeInitiateCall.mockResolvedValue({ success: true, call_sid: "CA_OK" });
    vi.spyOn(window, "open").mockImplementation(() => null);
  });

  it("with exotel_secure_calling_enabled=false shows coming soon and never initiates a call", async () => {
    renderSheet();

    await screen.findByText("Test brief for call.");

    const cta = screen.getByRole("button", { name: s.secure_call_coming_soon });
    expect(cta).toBeDisabled();

    await fireEvent.click(cta);
    expect(mockInvokeInitiateCall).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
    expect(screen.queryByText(s.ai_bridge_connecting)).not.toBeInTheDocument();
    expect(screen.queryByText(s.secure_call_connected)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: s.secure_call_call_directly })).not.toBeInTheDocument();
  });

  it("with flag true and initiate success: connecting first, then connected after resolve", async () => {
    mockConfig.exotelSecureCallingEnabled = true;

    let resolveCall!: (value: { success: boolean; call_sid?: string }) => void;
    mockInvokeInitiateCall.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCall = resolve;
        }),
    );

    renderSheet();
    await screen.findByText("Test brief for call.");

    const callNow = screen.getByRole("button", { name: s.ai_bridge_call_now });
    expect(callNow).toBeEnabled();
    await fireEvent.click(callNow);

    expect(await screen.findByText(s.secure_call_connecting)).toBeInTheDocument();
    expect(screen.queryByText(s.ai_bridge_connecting)).not.toBeInTheDocument();

    await act(async () => {
      resolveCall({ success: true, call_sid: "CA_OK" });
    });

    await waitFor(() => {
      expect(screen.getByText(s.ai_bridge_connecting)).toBeInTheDocument();
    });
    expect(window.open).not.toHaveBeenCalled();
    expect(mockInvokeInitiateCall).toHaveBeenCalledTimes(1);
  });

  it("with flag true and initiate failure: confirm dialog before tel:, no silent dial", async () => {
    mockConfig.exotelSecureCallingEnabled = true;
    mockInvokeInitiateCall.mockResolvedValue({ success: false, error: "exotel_down" });

    renderSheet();
    await screen.findByText("Test brief for call.");

    await fireEvent.click(screen.getByRole("button", { name: s.ai_bridge_call_now }));

    expect(await screen.findByText(s.secure_call_failed_title)).toBeInTheDocument();
    expect(
      screen.getByText(s.secure_call_failed_body_bridge.replace("{name}", "Bridge Vendor")),
    ).toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: s.secure_call_call_directly }));

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith("tel:9876500001", "_self");
    });
  });
});
