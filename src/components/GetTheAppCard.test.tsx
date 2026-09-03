import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GetTheAppCard } from "@/components/GetTheAppCard";

const mocks = vi.hoisted(() => ({
  submitAppNotifyLead: vi.fn(),
}));

vi.mock("@/lib/appNotifyLead", () => ({
  submitAppNotifyLead: mocks.submitAppNotifyLead,
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({
    s: {
      get_app_heading: "Get the Aaspaas Pro App",
      get_app_subtext: "Coming soon to Google Play",
      get_app_placeholder: "Phone number or email",
      get_app_notify: "Notify me",
      get_app_success: "We'll notify you when it's on Google Play.",
      get_app_invalid: "Enter a valid phone number or email.",
      get_app_error: "Could not save. Try again.",
    },
  }),
}));

describe("GetTheAppCard", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.submitAppNotifyLead.mockReset();
    mocks.submitAppNotifyLead.mockResolvedValue({ ok: true });
  });

  it("submits a contact and shows the success copy", async () => {
    render(<GetTheAppCard />);
    fireEvent.change(screen.getByTestId("get-the-app-contact"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("get-the-app-submit"));
    await waitFor(() => {
      expect(mocks.submitAppNotifyLead).toHaveBeenCalledWith("9876543210");
    });
    expect(await screen.findByTestId("get-the-app-success")).toHaveTextContent(
      "We'll notify you when it's on Google Play.",
    );
    expect(screen.queryByTestId("get-the-app-submit")).toBeNull();
    expect(localStorage.getItem("aaspaas:app_notify_lead")).toBe("1");
  });

  it("shows a validation error without leaving the form", async () => {
    mocks.submitAppNotifyLead.mockResolvedValue({ ok: false, reason: "invalid" });
    render(<GetTheAppCard />);
    fireEvent.change(screen.getByTestId("get-the-app-contact"), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByTestId("get-the-app-submit"));
    expect(await screen.findByTestId("get-the-app-error")).toHaveTextContent(
      "Enter a valid phone number or email.",
    );
    expect(screen.getByTestId("get-the-app-submit")).toBeTruthy();
    expect(screen.queryByTestId("get-the-app-success")).toBeNull();
    expect(localStorage.getItem("aaspaas:app_notify_lead")).toBeNull();
  });

  it("surfaces a save error instead of success when the RPC fails", async () => {
    mocks.submitAppNotifyLead.mockResolvedValue({ ok: false, reason: "error" });
    render(<GetTheAppCard />);
    fireEvent.change(screen.getByTestId("get-the-app-contact"), {
      target: { value: "notify@example.com" },
    });
    fireEvent.click(screen.getByTestId("get-the-app-submit"));
    expect(await screen.findByTestId("get-the-app-error")).toHaveTextContent(
      "Could not save. Try again.",
    );
    expect(screen.getByTestId("get-the-app-submit")).toBeTruthy();
    expect(screen.queryByTestId("get-the-app-success")).toBeNull();
    expect(localStorage.getItem("aaspaas:app_notify_lead")).toBeNull();
  });

  it("skips the form when this browser already submitted", () => {
    localStorage.setItem("aaspaas:app_notify_lead", "1");
    render(<GetTheAppCard />);
    expect(screen.getByTestId("get-the-app-success")).toBeTruthy();
    expect(screen.queryByTestId("get-the-app-contact")).toBeNull();
  });
});
