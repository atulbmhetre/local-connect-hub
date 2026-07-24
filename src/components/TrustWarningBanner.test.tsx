import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TrustWarningBanner } from "@/components/TrustWarningBanner";
import { strings } from "@/lib/strings";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

describe("vendorBinaryTrustTier", () => {
  const complete = {
    is_manual_verified: true,
    upi_verified: true,
    photo_selfie: "https://example.com/selfie.jpg",
    latitude: 18.5,
  };

  it("green only when all four Radar signals present", () => {
    expect(vendorBinaryTrustTier(complete)).toBe("green");
  });

  it("red when any signal missing — never yellow", () => {
    expect(vendorBinaryTrustTier({ ...complete, is_manual_verified: false })).toBe("red");
    expect(vendorBinaryTrustTier({ ...complete, upi_verified: false })).toBe("red");
    expect(vendorBinaryTrustTier({ ...complete, photo_selfie: null })).toBe("red");
    expect(vendorBinaryTrustTier({ ...complete, latitude: null })).toBe("red");
  });
});

describe("TrustWarningBanner binary (radar + bridge)", () => {
  it("radar: hides when green", () => {
    const { container } = render(<TrustWarningBanner tier="green" context="radar" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("radar: shows incomplete warning when red", () => {
    render(<TrustWarningBanner tier="red" context="radar" />);
    expect(screen.getByTestId("trust-warning-banner-radar")).toHaveTextContent(
      strings.en.trust_warning_red,
    );
  });

  it("radar: yellow input is treated as unverified (no pending branch)", () => {
    render(<TrustWarningBanner tier="yellow" context="radar" />);
    expect(screen.getByTestId("trust-warning-banner-radar")).toHaveTextContent(
      strings.en.trust_warning_red,
    );
    expect(screen.queryByText(strings.en.radar_trustPending)).not.toBeInTheDocument();
    expect(screen.queryByText(strings.en.trust_warning_yellow)).not.toBeInTheDocument();
  });

  it("bridge: hides when green, warns when red", () => {
    const { rerender, container } = render(
      <TrustWarningBanner tier="green" context="bridge" />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<TrustWarningBanner tier="red" context="bridge" />);
    expect(screen.getByTestId("trust-warning-banner-bridge")).toHaveTextContent(
      strings.en.trust_warning_red,
    );
  });

  it("parchi: shows unverified warning", () => {
    render(<TrustWarningBanner tier="red" context="parchi" />);
    expect(screen.getByTestId("trust-warning-banner-parchi")).toHaveTextContent(
      strings.en.trust_warning_red,
    );
  });

  it("tracking: still shows secure-connection privacy banner regardless of tier", () => {
    render(<TrustWarningBanner tier="red" context="tracking" />);
    expect(screen.getByText(strings.en.trust_secure_connection)).toBeInTheDocument();
    expect(screen.queryByTestId("trust-warning-banner-radar")).not.toBeInTheDocument();
  });
});
