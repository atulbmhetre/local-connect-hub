import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import { patchVendorOwn } from "./vendorPatch";

describe("R2 — vendor cannot self-set discoverable via client patch", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: null });
  });

  it("strips discoverable from the patch before calling vendor_update_own", async () => {
    await patchVendorOwn("vendor-1", "9876543210", {
      shop_name: "My Shop",
      discoverable: true,
    });

    expect(rpcMock).toHaveBeenCalledWith("vendor_update_own", {
      p_vendor_id: "vendor-1",
      p_vendor_phone: "9876543210",
      p_patch: { shop_name: "My Shop" },
    });
    const patch = rpcMock.mock.calls[0][1].p_patch as Record<string, unknown>;
    expect(patch).not.toHaveProperty("discoverable");
  });
});
