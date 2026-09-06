import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import HelpSupport from "@/pages/HelpSupport";
import { strings } from "@/lib/strings";

const { mockSendSupportEmail, mockNotifyAdmin } = vi.hoisted(() => ({
  mockSendSupportEmail: vi.fn(),
  mockNotifyAdmin: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device-help",
}));

vi.mock("@/components/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/settings/SettingsSection", () => ({
  SettingsPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/lib/supabase", () => ({
  invokeSendSupportEmail: (...args: unknown[]) => mockSendSupportEmail(...args),
  invokeNotifyAdmin: (...args: unknown[]) => mockNotifyAdmin(...args),
}));

describe("HelpSupport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem("aaspaas:vendor_id", "11111111-1111-1111-1111-111111111111");
    mockSendSupportEmail.mockResolvedValue({ ok: true, emailed: true, id: "msg-1" });
    mockNotifyAdmin.mockResolvedValue(undefined);
  });

  it("renders FAQ accordion and expands an item", async () => {
    render(
      <MemoryRouter>
        <HelpSupport />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("help-support-screen")).toBeInTheDocument();
    expect(screen.getByTestId("help-faq-accordion")).toBeInTheDocument();

    const trigger = screen.getByTestId("help-faq-trigger-0");
    expect(trigger).toHaveTextContent(strings.en.help_faq_q_find_vendor);
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(screen.getByTestId("help-faq-content-0")).toHaveTextContent(
        strings.en.help_faq_a_find_vendor,
      );
    });
  });

  it("Feedback submit calls send-support-email only (no admin notify)", async () => {
    render(
      <MemoryRouter>
        <HelpSupport />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("help-feedback-star-4"));
    fireEvent.change(screen.getByTestId("help-feedback-message"), {
      target: { value: "Love the radar search" },
    });
    fireEvent.click(screen.getByTestId("help-feedback-submit"));

    await waitFor(() => {
      expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
    });

    expect(mockSendSupportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "feedback",
        message: "Love the radar search",
        rating: 4,
        user_phone: "9876543210",
        vendor_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it("Contact Support submit emails without client admin notify", async () => {
    render(
      <MemoryRouter>
        <HelpSupport />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("help-contact-category-payment"));
    fireEvent.change(screen.getByTestId("help-contact-message"), {
      target: { value: "UPI payment stuck after claim" },
    });
    fireEvent.click(screen.getByTestId("help-contact-submit"));

    await waitFor(() => {
      expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
    });

    expect(mockSendSupportEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "contact",
        category: "payment",
        message: "UPI payment stuck after claim",
        user_phone: "9876543210",
        vendor_id: "11111111-1111-1111-1111-111111111111",
      }),
    );
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  it("Contact Support does not notify admin when email/persist fails", async () => {
    mockSendSupportEmail.mockResolvedValueOnce({ ok: false, error: "persist_failed" });

    render(
      <MemoryRouter>
        <HelpSupport />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("help-contact-category-account"));
    fireEvent.change(screen.getByTestId("help-contact-message"), {
      target: { value: "Cannot restore account" },
    });
    fireEvent.click(screen.getByTestId("help-contact-submit"));

    await waitFor(() => {
      expect(mockSendSupportEmail).toHaveBeenCalledTimes(1);
    });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });
});
