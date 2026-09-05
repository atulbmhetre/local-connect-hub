import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { strings } from "@/lib/strings";
import type { Vendor } from "@/lib/supabase";

const { mockRpc, showNetworkFailedToast, showNetworkRetryingToast } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  showNetworkFailedToast: vi.fn(),
  showNetworkRetryingToast: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  upsertUser: vi.fn(),
  incrementUserOrders: vi.fn(),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: () => "device-test" }));
vi.mock("@/lib/userIdentity", () => ({ getUserPhone: () => "9876543210" }));

vi.mock("@/hooks/useNetworkStatus", () => ({
  getNavigatorOnline: () => true,
}));

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast,
  showNetworkFailedToast,
  dismissNetworkRetryingToast: vi.fn(),
}));

vi.mock("@/lib/orderPlacementIdempotency", () => ({
  buildOrderPlacementFingerprint: () => "fp",
  getOrCreateOrderPlacementIdempotencyKey: () => "idem-key",
  clearOrderPlacementIdempotencyKey: vi.fn(),
}));

import { executeOrderInsert } from "@/lib/executeOrderInsert";

const vendor = {
  id: "vendor-1",
  name: "Test",
  shop_name: "Test Shop",
  category: "Grocery",
  upi_id: "test@upi",
  phone: "9999999999",
  is_active: true,
  latitude: 18.5,
  longitude: 73.8,
  verification_status: "unverified",
  shop_photo_url: null,
  upi_verified: false,
  is_manual_verified: false,
  created_at: new Date().toISOString(),
  service_mode: "help",
  cancel_reason_1: null,
  cancel_reason_2: null,
  cancel_reason_3: null,
  cancel_reason_4: null,
  service_radius_km: 15,
} as Vendor;

describe("executeOrderInsert place timeout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a hung create_customer_request and surfaces network failed retry", async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === "create_customer_request") {
        return new Promise(() => {});
      }
      return Promise.resolve({ data: null, error: null });
    });

    const setSending = vi.fn();
    const promise = executeOrderInsert(
      {
        phone: "9876543210",
        vendor,
        message: "Need help",
        resolvedServiceMode: "help",
        isHelpMode: true,
        isDeliveryMode: false,
        isAppointmentMode: false,
        showRecurrence: false,
        appointmentLocation: "decide",
        helpLocation: "shop",
        appointmentTiming: "scheduled",
        appointmentDate: "",
        appointmentTime: "",
        deliverySlot: "asap",
        recurrenceKind: "one_time",
        recurrenceCustomDays: "3",
        selectedAddressId: null,
        addresses: [],
        newAddress: "",
        saveAddress: false,
        customerLat: null,
        customerLng: null,
        canServeAtCustomer: true,
        canServeAtVendor: true,
        selectedMenuItems: {},
        menuItems: [],
        minDeliveryOrderAmount: null,
        orderCategoryId: null,
        maxOrderMessageChars: 500,
        s: strings.en,
      },
      {
        setSending,
        setOfflineApptError: vi.fn(),
        setTrustBlock: vi.fn(),
        setMessage: vi.fn(),
        setSelectedMenuItems: vi.fn(),
        setPendingPhone: vi.fn(),
        onClose: vi.fn(),
        fetchPaymentBlockStatus: vi.fn(),
      },
    );

    // 3 attempts × 15s + backoff (1s + 2s)
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(15_000);

    await promise;

    expect(showNetworkRetryingToast).toHaveBeenCalled();
    expect(showNetworkFailedToast).toHaveBeenCalled();
    expect(setSending).toHaveBeenCalledWith(false);
    expect(
      mockRpc.mock.calls.filter((call) => call[0] === "create_customer_request"),
    ).toHaveLength(3);
  });
});
