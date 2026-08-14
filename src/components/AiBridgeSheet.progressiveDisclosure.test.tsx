import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { strings } from "@/lib/strings";
import { AiBridgeSheet, type AiBridgeVendor } from "@/components/AiBridgeSheet";

const s = strings.en;

const mockSupabase = vi.hoisted(() => ({
  from: () => ({
    select: () => ({
      eq: () => ({
        eq: async () => ({ data: [], error: null }),
      }),
    }),
  }),
  rpc: async () => ({ data: [], error: null }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: mockSupabase,
  invokeInitiateCall: vi.fn(),
  buildVendorBrief: vi.fn(async () => ({ ok: true, brief: "Brief." })),
  emojiForVendorCategory: () => "🛒",
  useCategoryLabel: () => (c: string) => c,
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

vi.mock("@/components/TrustBadge", () => ({
  TrustBadge: ({
    isManualVerified,
    showLabel,
  }: {
    isManualVerified?: boolean | null;
    showLabel?: boolean;
  }) => (
    <span data-testid={isManualVerified === true ? "badge-verified" : "badge-unverified"}>
      {showLabel
        ? isManualVerified === true
          ? `${s.badge_verified} · ${s.trust_tier_bronze}`
          : s.badge_unverified
        : null}
    </span>
  ),
}));

vi.mock("@/components/TrustWarningBanner", () => ({
  TrustWarningBanner: () => <div data-testid="trust-warning-banner" />,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

function baseVendor(overrides: Partial<AiBridgeVendor> = {}): AiBridgeVendor {
  return {
    id: "vendor-bridge-pd-1",
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
    ...overrides,
  };
}

function renderSheet(vendor: AiBridgeVendor) {
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

/** RAD-09: never show TrustBadge and legacy vendorTier / getVerificationCopy G/Y/R copy together. */
describe("AiBridgeSheet progressive disclosure (RAD-09)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("unverified: TrustBadge only — no legacy G/Y/R verificationCopy label", async () => {
    renderSheet(baseVendor({ is_manual_verified: false, verification_status: "unverified" }));

    await screen.findByText("Brief.");

    expect(screen.getByTestId("badge-unverified")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-verified")).not.toBeInTheDocument();
    expect(screen.getAllByText(s.badge_unverified)).toHaveLength(1);

    // Legacy getVerificationCopy labels must not appear beside the badge.
    expect(screen.queryByText(s.vendor_verified_pro)).not.toBeInTheDocument();
    expect(screen.queryByText(s.verification_yellow_label)).not.toBeInTheDocument();
    // Binary incomplete-verification banner is a separate system (left intact).
    expect(screen.getByTestId("trust-warning-banner")).toBeInTheDocument();
  });

  it("verified: TrustBadge only — no legacy Verified Professional / pending copy", async () => {
    renderSheet(
      baseVendor({
        is_manual_verified: true,
        verification_status: "business_verified",
      }),
    );

    await screen.findByText("Brief.");

    expect(screen.getByTestId("badge-verified")).toBeInTheDocument();
    expect(screen.queryByTestId("badge-unverified")).not.toBeInTheDocument();
    expect(screen.getByText(`${s.badge_verified} · ${s.trust_tier_bronze}`)).toBeInTheDocument();

    expect(screen.queryByText(s.vendor_verified_pro)).not.toBeInTheDocument();
    expect(screen.queryByText(s.verification_yellow_label)).not.toBeInTheDocument();
    expect(screen.queryByText(s.settings_unverified)).not.toBeInTheDocument();
  });
});
