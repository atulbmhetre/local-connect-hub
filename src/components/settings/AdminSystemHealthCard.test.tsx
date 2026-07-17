import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AdminSystemHealthCard } from "@/components/settings/AdminSystemHealthCard";

const rpc = vi.fn();
const from = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => from(...args),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

describe("AdminSystemHealthCard FCM signal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    from.mockReturnValue({
      select: () => ({
        is: () => Promise.resolve({ data: [], error: null }),
      }),
    });
  });

  it("shows FCM failure total and breakdown from get_admin_fcm_failure_stats", async () => {
    rpc.mockResolvedValue({
      data: [
        { notification_type: "user-order_update", failure_events: 3, success_events: 10 },
        { notification_type: "vendor-new-order", failure_events: 1, success_events: 5 },
      ],
      error: null,
    });

    render(<AdminSystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-fcm-failure-total")).toHaveTextContent("4 failed sends");
    });
    expect(screen.getByTestId("admin-fcm-failure-breakdown")).toHaveTextContent(
      "user-order_update: 3 failed",
    );
    expect(rpc).toHaveBeenCalledWith("get_admin_fcm_failure_stats", { p_hours: 24 });
  });
});
