import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyVendorWaiveoff } from "@/lib/applyVendorWaiveoff";

const {
  mockInvokeNotifyVendor,
  mockLogAdminAction,
  mockApplyWaiveoffRpc,
} = vi.hoisted(() => ({
  mockInvokeNotifyVendor: vi.fn(),
  mockLogAdminAction: vi.fn(),
  mockApplyWaiveoffRpc: vi.fn(async () => ({ data: null, error: null })),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "8888169446",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fnName: string, _params: unknown) => {
      if (fnName === "admin_apply_vendor_waiveoff") {
        return mockApplyWaiveoffRpc();
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
  invokeNotifyVendor: mockInvokeNotifyVendor,
}));

vi.mock("@/lib/adminAudit", () => ({
  logAdminAction: mockLogAdminAction,
}));

const ALL_LANGS_ENABLED = {
  localizationEnabled: true,
  langHindiEnabled: true,
  langMarathiEnabled: true,
};

const VENDOR = { id: "vendor-1", phone: "9876543210" };

describe("applyVendorWaiveoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApplyWaiveoffRpc.mockResolvedValue({ data: null, error: null });
  });

  it("applies waive-off and audits without client notify", async () => {
    const result = await applyVendorWaiveoff(VENDOR, 50, 3, ALL_LANGS_ENABLED);

    expect(result).toEqual({ ok: true });
    expect(mockApplyWaiveoffRpc).toHaveBeenCalled();
    expect(mockInvokeNotifyVendor).not.toHaveBeenCalled();
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      "update_config",
      "vendor",
      "vendor-1",
      "waiveoff:50%x3months",
      undefined,
    );
  });

  it("returns the RPC error and sends no push when apply fails", async () => {
    mockApplyWaiveoffRpc.mockResolvedValue({
      data: null,
      error: { message: "unauthorized" } as never,
    });

    const result = await applyVendorWaiveoff(VENDOR, 50, 3, ALL_LANGS_ENABLED);

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mockInvokeNotifyVendor).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
