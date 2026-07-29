import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IncomingOrdersSection } from "@/components/IncomingOrdersSection";
import { strings } from "@/lib/strings";

const FULFILLED_ORDER = {
  id: "req-fulfilled-1",
  device_id: "dev-1",
  vendor_id: "vendor-1",
  message: "Test order",
  status: "fulfilled",
  created_at: new Date().toISOString(),
  user_phone: "9876543210",
  delivery_address: null,
  delivery_slot: "morning",
  appointment_time: null,
  appointment_status: null,
  cancel_reason: null,
  is_edited: false,
  payment_status: null,
  payment_utr: null,
  customer_latitude: null,
  customer_longitude: null,
  category_id: "cat-1",
  category_label: "Food",
  category_emoji: "🍽️",
  service_mode: "delivery",
};

const { mockRpc, mockInvokeNotifyUser } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockInvokeNotifyUser: vi.fn(),
}));

function chainResult(data: unknown = []) {
  const result = Promise.resolve({ data, error: null });
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => result),
    then: result.then.bind(result),
    catch: result.catch.bind(result),
    finally: result.finally.bind(result),
  };
  return chain;
}

const mockChannel = {
  on: vi.fn(function (this: typeof mockChannel) {
    return this;
  }),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
};

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mockRpc,
    from: vi.fn(() => chainResult([])),
    channel: vi.fn(() => mockChannel),
    removeChannel: vi.fn(),
  },
  invokeNotifyUser: mockInvokeNotifyUser,
  invokecalculateTrustScore: vi.fn(),
  useCategoryLabel: () => (label: string) => label,
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9000000001",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("@/lib/vendorBackgroundLocation", () => ({
  startOrderTracking: vi.fn(),
  stopOrderTracking: vi.fn(),
}));

vi.mock("@/lib/iveStartedNotify", () => ({
  sendIveStartedCustomerNotification: vi.fn(),
}));

vi.mock("@/components/CallBridgeSheet", () => ({
  CallBridgeSheet: () => null,
}));

function defaultRpc(name: string) {
  switch (name) {
    case "get_vendor_incoming_orders":
      return { data: [FULFILLED_ORDER], error: null };
    case "get_vendor_incoming_orders_count":
      return { data: 1, error: null };
    case "get_vendor_khata_request_ids":
      return { data: [], error: null };
    case "get_vendor_customer_trust":
      return { data: [], error: null };
    case "get_vendor_order_bills":
      return { data: [], error: null };
    case "insert_bill_with_items":
      return { data: "bill-1", error: null };
    default:
      return { data: null, error: null };
  }
}

function renderSection() {
  return render(
    <MemoryRouter>
      <IncomingOrdersSection
        vendorId="vendor-1"
        serviceMode="delivery"
        shopName="Test Shop"
        khataAmberLimit={0}
        khataRedLimit={0}
        cancelReasons={["Busy", "Closed", "Other", ""]}
      />
    </MemoryRouter>,
  );
}

describe("IncomingOrdersSection khata ledger submit lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(async (name: string) => defaultRpc(name));
    window.scrollBy = vi.fn();
  });

  it("rapid double-tap on ledger submit calls insert_bill_with_items only once", async () => {
    let resolveInsert: (() => void) | undefined;
    const insertGate = new Promise<void>((resolve) => {
      resolveInsert = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "insert_bill_with_items") {
        await insertGate;
        return { data: "bill-1", error: null };
      }
      return defaultRpc(name);
    });

    renderSection();

    await waitFor(() => {
      expect(screen.getByTestId("incoming-order-card")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(strings.en.khata_addToLedger));

    await waitFor(() => {
      expect(screen.getByTestId("ledger-submit-btn")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(strings.en.incoming_ledger_amount_label), {
      target: { value: "120" },
    });

    const submitBtn = screen.getByTestId("ledger-submit-btn");
    fireEvent.click(submitBtn);
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "insert_bill_with_items"),
      ).toHaveLength(1);
    });

    resolveInsert?.();
    await waitFor(() => {
      expect(mockInvokeNotifyUser).toHaveBeenCalledTimes(1);
    });
  });
});
