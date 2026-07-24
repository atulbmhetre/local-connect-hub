import { describe, expect, it, vi, beforeEach } from "vitest";
import { vendorBinaryTrustTier } from "@/lib/vendorBinaryTrust";
import type { AiBridgeVendor } from "@/components/AiBridgeSheet";
import type { VerificationStatus } from "@/lib/supabase";

/**
 * Mirrors MyOrders openHelpVendorCall mapping after fetchVendorsVisibleToCustomer
 * (real verification fields — not the old hardcoded unverified stub).
 */
function mapLiveVendorToAiBridge(
  orderVendorId: string,
  shopFallback: string,
  phone: string,
  live: {
    verification_status?: VerificationStatus | null;
    is_manual_verified?: boolean | null;
    shop_photo_url?: string | null;
    upi_verified?: boolean | null;
    photo_selfie?: string | null;
    latitude?: number | null;
    total_helped?: number | null;
    on_time_rate?: number | null;
    vendor_note?: string | null;
  } | undefined,
): AiBridgeVendor {
  return {
    id: orderVendorId,
    name: shopFallback,
    shop_name: shopFallback,
    category: "help",
    vendor_note: live?.vendor_note ?? null,
    phone,
    service_mode: "help",
    verification_status: live?.verification_status ?? "unverified",
    is_manual_verified: live?.is_manual_verified === true,
    shop_photo_url: live?.shop_photo_url ?? null,
    upi_verified: live?.upi_verified === true,
    photo_selfie: live?.photo_selfie ?? null,
    latitude: live?.latitude ?? null,
    total_helped: live?.total_helped ?? 0,
    on_time_rate: live?.on_time_rate ?? null,
  };
}

describe("MyOrders → AiBridge vendor trust mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("legacy hardcoded unverified stub always yields red banner tier", () => {
    const legacy = mapLiveVendorToAiBridge("v1", "Shop", "999", undefined);
    expect(legacy.is_manual_verified).toBe(false);
    expect(legacy.verification_status).toBe("unverified");
    expect(vendorBinaryTrustTier(legacy)).toBe("red");
  });

  it("uses real verified fields from fetched vendor for green banner tier", () => {
    const mapped = mapLiveVendorToAiBridge("v1", "Shop", "999", {
      verification_status: "business_verified",
      is_manual_verified: true,
      upi_verified: true,
      photo_selfie: "https://example.com/s.jpg",
      latitude: 18.5,
      shop_photo_url: "https://example.com/shop.jpg",
      total_helped: 12,
      on_time_rate: 90,
    });
    expect(mapped.is_manual_verified).toBe(true);
    expect(mapped.upi_verified).toBe(true);
    expect(mapped.total_helped).toBe(12);
    expect(vendorBinaryTrustTier(mapped)).toBe("green");
  });

  it("partial verification still yields red (binary — no yellow)", () => {
    const mapped = mapLiveVendorToAiBridge("v1", "Shop", "999", {
      verification_status: "Yellow",
      is_manual_verified: false,
      upi_verified: true,
      photo_selfie: "https://example.com/s.jpg",
      latitude: 18.5,
    });
    expect(vendorBinaryTrustTier(mapped)).toBe("red");
  });
});
