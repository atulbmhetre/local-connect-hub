import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mirrors Index neighbour-sheet active-order identity args — must stay
 * phone-if-present (not hard-coded null), matching RadarVendorCard.
 */
function activeOrderRpcArgs(phone: string | null, deviceId: string, vendorId: string) {
  return {
    p_user_phone: phone,
    p_device_id: deviceId,
    p_vendor_ids: [vendorId],
  };
}

describe("Home neighbour active-order identity", () => {
  it("passes phone when known (not null)", () => {
    expect(activeOrderRpcArgs("9876543210", "dev-1", "v1")).toEqual({
      p_user_phone: "9876543210",
      p_device_id: "dev-1",
      p_vendor_ids: ["v1"],
    });
  });

  it("passes null phone only when unknown, still sends device", () => {
    expect(activeOrderRpcArgs(null, "dev-1", "v1").p_user_phone).toBeNull();
    expect(activeOrderRpcArgs(null, "dev-1", "v1").p_device_id).toBe("dev-1");
  });
});

describe("Index.tsx active-order calls", () => {
  it("does not hard-code p_user_phone: null for get_my_active_request_vendor_ids", () => {
    const src = readFileSync(join(process.cwd(), "src/pages/Index.tsx"), "utf8");
    const blocks = src.split("get_my_active_request_vendor_ids");
    for (let i = 1; i < blocks.length; i++) {
      const window = blocks[i].slice(0, 220);
      expect(window).not.toMatch(/p_user_phone:\s*null/);
      expect(window).toMatch(/p_user_phone:\s*getUserPhone\(\)/);
    }
  });
});
