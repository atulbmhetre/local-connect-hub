import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { TrustBadge } from "@/components/TrustBadge";
import { strings } from "@/lib/strings";

const { captureError, fromMock } = vi.hoisted(() => ({
  captureError: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

describe("TrustBadge verification-tier fetch captureError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures vendor_verification fetch failure (verified vendor, no precomputed tier)", async () => {
    const err = { message: "forced_tier_fetch_fail", code: "PGRST301" };
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: async () => ({ data: null, error: err }),
        }),
      }),
    });

    render(
      <TrustBadge
        vendorId="vendor-tier-fail-1"
        isManualVerified
        showLabel
      />,
    );

    await waitFor(() => {
      expect(captureError).toHaveBeenCalledWith(
        err,
        expect.objectContaining({
          scope: "trustBadge.vendorVerification",
          vendorId: "vendor-tier-fail-1",
        }),
      );
    });
  });
});
