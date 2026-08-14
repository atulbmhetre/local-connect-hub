import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { IncomingOrdersSection } from "@/components/IncomingOrdersSection";
import { strings } from "@/lib/strings";

const HELP_ORDER = {
  id: "req-help-1",
  device_id: "dev-1",
  vendor_id: "vendor-1",
  message: "Need help",
  status: "sent",
  created_at: new Date().toISOString(),
  user_phone: "9876543210",
  delivery_address: null,
  delivery_slot: null,
  appointment_time: null,
  appointment_status: null,
  cancel_reason: null,
  is_edited: false,
  payment_status: null,
  payment_utr: null,
  customer_latitude: null,
  customer_longitude: null,
  category_id: "cat-1",
  category_label: "Help",
  category_emoji: "🆘",
  service_mode: "help",
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

vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9000000001" }));
vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));
vi.mock("@/lib/vendorBackgroundLocation", () => ({
  startOrderTracking: vi.fn(),
  stopOrderTracking: vi.fn(),
  syncHelpAcceptedOrderTracking: vi.fn(),
}));
vi.mock("@/lib/iveStartedNotify", () => ({ sendIveStartedCustomerNotification: vi.fn() }));
vi.mock("@/components/CallBridgeSheet", () => ({ CallBridgeSheet: () => null }));

function defaultRpc(name: string) {
  switch (name) {
    case "get_vendor_incoming_orders":
      return { data: [HELP_ORDER], error: null };
    case "get_vendor_incoming_orders_count":
      return { data: 1, error: null };
    case "vendor_accept_order":
      return { data: true, error: null };
    default:
      return { data: null, error: null };
  }
}

describe("IncomingOrdersSection acceptHelp submit lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.scrollBy = vi.fn();
    mockRpc.mockImplementation(async (name: string) => defaultRpc(name));
  });

  it("rapid double-tap on accept help calls vendor_accept_order only once", async () => {
    let resolveAccept: (() => void) | undefined;
    const acceptGate = new Promise<void>((resolve) => {
      resolveAccept = resolve;
    });

    mockRpc.mockImplementation(async (name: string) => {
      if (name === "vendor_accept_order") {
        await acceptGate;
        return { data: true, error: null };
      }
      return defaultRpc(name);
    });

    render(
      <MemoryRouter>
        <IncomingOrdersSection
          vendorId="vendor-1"
          serviceMode="help"
          shopName="Test Shop"
          khataAmberLimit={0}
          khataRedLimit={0}
          cancelReasons={["Busy", "Closed", "Other", ""]}
        />
      </MemoryRouter>,
    );

    const acceptBtn = await screen.findByTestId("incoming-accept-btn");
    fireEvent.click(acceptBtn);
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(
        mockRpc.mock.calls.filter((call) => call[0] === "vendor_accept_order"),
      ).toHaveLength(1);
    });

    resolveAccept?.();
    await waitFor(() => {
      expect(mockInvokeNotifyUser).toHaveBeenCalledTimes(1);
    });
  });
});
