import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { strings } from "@/lib/strings";
import { PhoneEntrySheet } from "@/components/PhoneEntrySheet";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: [], error: null })),
  },
}));

vi.mock("@/lib/userIdentity", () => ({
  saveUserPhone: vi.fn(() => ({ normalized: "9876543210", previous: null })),
}));

vi.mock("@/lib/referral", () => ({
  recordUserReferral: vi.fn(),
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device",
}));

vi.mock("@/lib/sentry", () => ({
  captureError: vi.fn(),
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    lang: currentLang,
    s: strings[currentLang],
    setLang: vi.fn(),
  }),
}));

let currentLang: "hi" | "mr" = "hi";

describe("PhoneEntrySheet localization", () => {
  it("renders HI phone-entry strings (not English hardcodes)", () => {
    currentLang = "hi";
    render(
      <PhoneEntrySheet isOpen onClose={() => {}} onConfirmed={() => {}} skipRecovery />,
    );

    expect(screen.getByText(strings.hi.phone_entry_title)).toBeInTheDocument();
    expect(screen.getByText(strings.hi.phone_entry_subtitle)).toBeInTheDocument();
    expect(screen.getByText(strings.hi.phone_entry_continue)).toBeInTheDocument();
    expect(screen.getByText(strings.hi.cancel)).toBeInTheDocument();
    expect(screen.getByText(strings.hi.phone_entry_privacy)).toBeInTheDocument();
    expect(screen.queryByText("Enter your mobile number")).not.toBeInTheDocument();
  });

  it("renders MR phone-entry strings (not English hardcodes)", () => {
    currentLang = "mr";
    render(
      <PhoneEntrySheet isOpen onClose={() => {}} onConfirmed={() => {}} skipRecovery />,
    );

    expect(screen.getByText(strings.mr.phone_entry_title)).toBeInTheDocument();
    expect(screen.getByText(strings.mr.phone_entry_subtitle)).toBeInTheDocument();
    expect(screen.getByText(strings.mr.phone_entry_continue)).toBeInTheDocument();
    expect(screen.getByText(strings.mr.phone_entry_privacy)).toBeInTheDocument();
    expect(screen.queryByText("Enter your mobile number")).not.toBeInTheDocument();
  });

  it("shows HI invalid-phone error", async () => {
    currentLang = "hi";
    render(
      <PhoneEntrySheet isOpen onClose={() => {}} onConfirmed={() => {}} skipRecovery />,
    );
    fireEvent.click(screen.getByText(strings.hi.phone_entry_continue));
    expect(await screen.findByText(strings.hi.phone_entry_invalid)).toBeInTheDocument();
  });
});

describe("recovery_welcome catalogs", () => {
  it("HI/MR recovery_welcome are translated (not English)", () => {
    expect(strings.hi.recovery_welcome_title).not.toBe(strings.en.recovery_welcome_title);
    expect(strings.mr.recovery_welcome_title).not.toBe(strings.en.recovery_welcome_title);
    expect(strings.hi.recovery_welcome_body).toContain("{count}");
    expect(strings.mr.recovery_welcome_body).toContain("{count}");
    expect(strings.hi.recovery_welcome_title).toMatch(/स्वागत/);
    expect(strings.mr.recovery_welcome_title).toMatch(/स्वागत/);
  });
});
