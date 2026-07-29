import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BillSheet } from "@/components/BillSheet";
import { strings } from "@/lib/strings";

const { mockRpc, mockInvokeNotifyUser } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInvokeNotifyUser: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc },
  invokeNotifyUser: mockInvokeNotifyUser,
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9000000001",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor-community/speech-recognition", () => ({
  SpeechRecognition: {},
}));

vi.mock("@/components/BillMenuCatalogPicker", () => ({
  BillMenuCatalogPicker: () => null,
}));

function renderBillSheet(onClose: () => void) {
  return render(
    <BillSheet
      isOpen
      onClose={onClose}
      requestId="req-1"
      vendorId="vendor-1"
      userPhone="9876543210"
      shopName="Test Shop"
      khataAmberLimit={0}
      khataRedLimit={0}
    />,
  );
}

async function fillBillAndOpenConfirm() {
  fireEvent.change(screen.getByPlaceholderText(strings.en.bill_itemName), {
    target: { value: "Tea" },
  });
  fireEvent.change(screen.getByLabelText("Unit price"), {
    target: { value: "50" },
  });
  fireEvent.click(screen.getByTestId("bill-submit-btn"));
  await waitFor(() => {
    expect(screen.getByText(strings.en.bill_confirmSendTitle)).toBeInTheDocument();
  });
}

describe("BillSheet send lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_vendor_order_bills") {
        return { data: [], error: null };
      }
      return { data: "bill-1", error: null };
    });
  });

  it("rapid double-tap on confirm send calls insert_bill_with_items only once", async () => {
    const onClose = vi.fn();
    let resolveInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_vendor_order_bills") {
        return { data: [], error: null };
      }
      if (name === "insert_bill_with_items") {
        await insertGate;
        return { data: "bill-1", error: null };
      }
      return { data: null, error: null };
    });

    renderBillSheet(onClose);
    await fillBillAndOpenConfirm();

    const confirmButtons = screen.getAllByRole("button", { name: strings.en.bill_send });
    const confirmBtn = confirmButtons[confirmButtons.length - 1];
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "insert_bill_with_items"),
      ).toHaveLength(1);
    });

    resolveInsert?.();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockInvokeNotifyUser).toHaveBeenCalledTimes(1);
    });
  });
});
