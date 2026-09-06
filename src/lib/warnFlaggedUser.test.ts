import { describe, expect, it, vi, beforeEach } from "vitest";
import { warnFlaggedUser } from "@/lib/warnFlaggedUser";

const {
  mockInvokeNotifyUser,
  mockLogAdminAction,
  mockAdminWarnUser,
} = vi.hoisted(() => ({
  mockInvokeNotifyUser: vi.fn(),
  mockLogAdminAction: vi.fn(),
  mockAdminWarnUser: vi.fn(async () => ({ data: 2, error: null })),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "8888169446",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fnName: string, _params: unknown) => {
      if (fnName === "admin_warn_user") {
        return mockAdminWarnUser();
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
  invokeNotifyUser: mockInvokeNotifyUser,
}));

vi.mock("@/lib/adminAudit", () => ({
  logAdminAction: mockLogAdminAction,
}));

describe("warnFlaggedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminWarnUser.mockResolvedValue({ data: 2, error: null });
  });

  it("persists warn via RPC and audits without client notify", async () => {
    const result = await warnFlaggedUser("9876543210", {
      localizationEnabled: true,
      langHindiEnabled: true,
      langMarathiEnabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mockAdminWarnUser).toHaveBeenCalled();
    expect(mockInvokeNotifyUser).not.toHaveBeenCalled();
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      "warn_user",
      "user",
      "9876543210",
      null,
      undefined,
    );
  });

  it("returns warn_count_not_saved when RPC fails", async () => {
    mockAdminWarnUser.mockResolvedValue({ data: null, error: { message: "fail" } });

    const result = await warnFlaggedUser("9876543210", {
      localizationEnabled: true,
      langHindiEnabled: true,
      langMarathiEnabled: true,
    });

    expect(result).toEqual({ ok: false, error: "warn_count_not_saved" });
    expect(mockInvokeNotifyUser).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
