import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LedgerView from "@/pages/LedgerView";
import { strings } from "@/lib/strings";

const { mockRpc, mockInvokeNotifyUser } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInvokeNotifyUser: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc },
  invokeNotifyUser: mockInvokeNotifyUser,
  invokeInitiateCall: vi.fn(),
}));

vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9000000001" }));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/components/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/NetworkErrorBanner", () => ({ NetworkErrorBanner: () => null }));
vi.mock("@/hooks/useNetworkStatus", () => ({ getNavigatorOnline: () => true }));
vi.mock("@/lib/withNetworkRetry", async () => {
  const actual = await vi.importActual<typeof import("@/lib/withNetworkRetry")>("@/lib/withNetworkRetry");
  return actual;
});

const VENDOR_OWN = {
  shop_name: "Test Shop",
  ledger_cycle_start: null,
  khata_amber_limit: 0,
  khata_red_limit: 0,
  phone: "9000000001",
  service_mode: "help",
};

const LEDGER_ENTRY = {
  user_phone: "9876543210",
  total_outstanding: 100,
  last_updated: new Date().toISOString(),
};

vi.mock("@/components/settings/SettingsSection", () => ({
  SettingsPageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
  SettingsCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("LedgerView payment submit lock", () => {
  beforeAll(() => {
    localStorage.setItem("aaspaas:vendor_id", "vendor-1");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_vendor_own") return { data: VENDOR_OWN, error: null };
      if (name === "get_vendor_khata_ledger") return { data: [LEDGER_ENTRY], error: null };
      if (name === "get_vendor_customer_names") return { data: [], error: null };
      if (name === "get_vendor_khata_transactions") return { data: [], error: null };
      if (name === "vendor_record_khata_payment") return { data: 0, error: null };
      return { data: null, error: null };
    });
  });

  it("rapid double-tap on save payment calls vendor_record_khata_payment only once", async () => {
    let resolvePayment: (() => void) | undefined;
    const paymentGate = new Promise<void>((resolve) => {
      resolvePayment = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_vendor_own") return { data: VENDOR_OWN, error: null };
      if (name === "get_vendor_khata_ledger") return { data: [LEDGER_ENTRY], error: null };
      if (name === "get_vendor_customer_names") return { data: [], error: null };
      if (name === "get_vendor_khata_transactions") return { data: [], error: null };
      if (name === "vendor_record_khata_payment") {
        await paymentGate;
        return { data: 0, error: null };
      }
      return { data: null, error: null };
    });

    render(
      <MemoryRouter initialEntries={["/ledger"]}>
        <LedgerView />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ledger-screen")).toHaveAttribute("data-loading", "false");
    });
    fireEvent.click(screen.getByText("••••3210"));
    fireEvent.click(await screen.findByTestId("ledger-mark-paid-btn"));
    fireEvent.change(await screen.findByTestId("ledger-partial-input"), {
      target: { value: "100" },
    });

    const saveBtn = screen.getByTestId("ledger-save-amount-btn");
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "vendor_record_khata_payment"),
      ).toHaveLength(1);
    });

    resolvePayment?.();
    await waitFor(() => {
      expect(mockInvokeNotifyUser).toHaveBeenCalledTimes(1);
    });
  });
});
