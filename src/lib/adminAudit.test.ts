import { describe, expect, it, vi, beforeEach } from "vitest";
import { logAdminAction } from "@/lib/adminAudit";

const { mockRpc, mockGetUserPhone } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockGetUserPhone: vi.fn(() => "9999999999"),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: mockRpc,
  },
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: mockGetUserPhone,
}));

describe("logAdminAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockReturnValue({
      then: (cb: (result: { error: null }) => void) => {
        cb({ error: null });
        return Promise.resolve({ error: null });
      },
    });
  });

  it("writes action_type, target_type, target_id, and reason via RPC", async () => {
    logAdminAction("warn_user", "user", "9876543210", "Test note");

    expect(mockRpc).toHaveBeenCalledWith("log_admin_action", {
      p_admin_phone: "9999999999",
      p_action_type: "warn_user",
      p_target_type: "user",
      p_target_id: "9876543210",
      p_notes: "Test note",
    });
  });
});
