import { describe, expect, it, vi, beforeEach } from "vitest";
import { logAdminAction } from "@/lib/adminAudit";

const { mockInsert, mockGetUserPhone } = vi.hoisted(() => ({
  mockInsert: vi.fn(),
  mockGetUserPhone: vi.fn(() => "9999999999"),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockInsert,
    })),
  },
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: mockGetUserPhone,
}));

describe("logAdminAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({
      then: (cb: (result: { error: null }) => void) => {
        cb({ error: null });
        return Promise.resolve({ error: null });
      },
    });
  });

  it("writes action_type, target_type, target_id, and reason", async () => {
    logAdminAction("warn_user", "user", "9876543210", "Test note");

    expect(mockInsert).toHaveBeenCalledWith({
      admin_phone: "9999999999",
      action_type: "warn_user",
      target_type: "user",
      target_id: "9876543210",
      reason: "Test note",
    });
  });
});
