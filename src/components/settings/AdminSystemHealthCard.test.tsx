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
    rpc.mockImplementation((name: string) => {
      if (name === "get_admin_fcm_failure_stats") {
        return Promise.resolve({ data: [], error: null });
      }
      if (name === "get_admin_radar_health_stats") {
        return Promise.resolve({
          data: {
            total_searches: 10,
            zero_result_searches: 1,
            zero_result_rate_pct: 10,
            active_categories_count: 5,
            categories_ok: true,
          },
          error: null,
        });
      }
      if (name === "get_admin_restore_health_stats") {
        return Promise.resolve({
          data: {
            attempts: 8,
            successes: 5,
            denied_banned: 1,
            denied_deleted: 1,
            not_found: 1,
            offline_now_restorable: 1,
            hidden_now_restorable: 1,
            success_rate_pct: 62.5,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("shows FCM failure total and breakdown from get_admin_fcm_failure_stats", async () => {
    rpc.mockImplementation((name: string) => {
      if (name === "get_admin_fcm_failure_stats") {
        return Promise.resolve({
          data: [
            { notification_type: "user-order_update", failure_events: 3, success_events: 10 },
            { notification_type: "vendor-new-order", failure_events: 1, success_events: 5 },
          ],
          error: null,
        });
      }
      if (name === "get_admin_radar_health_stats") {
        return Promise.resolve({
          data: {
            total_searches: 4,
            zero_result_searches: 0,
            zero_result_rate_pct: 0,
            active_categories_count: 3,
            categories_ok: true,
          },
          error: null,
        });
      }
      if (name === "get_admin_restore_health_stats") {
        return Promise.resolve({
          data: {
            attempts: 0,
            successes: 0,
            denied_banned: 0,
            denied_deleted: 0,
            not_found: 0,
            offline_now_restorable: 0,
            hidden_now_restorable: 0,
            success_rate_pct: 0,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
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

  it("shows radar health summary from get_admin_radar_health_stats", async () => {
    render(<AdminSystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-radar-health-summary")).toHaveTextContent(
        "Radar categories OK",
      );
    });
    expect(screen.getByTestId("admin-radar-health-detail")).toHaveTextContent("10 searches");
    expect(rpc).toHaveBeenCalledWith("get_admin_radar_health_stats", { p_hours: 24 });
  });

  it("shows restore health summary from get_admin_restore_health_stats", async () => {
    render(<AdminSystemHealthCard />);

    await waitFor(() => {
      expect(screen.getByTestId("admin-restore-health-summary")).toHaveTextContent(
        "5/8 restored (62.5%)",
      );
    });
    expect(screen.getByTestId("admin-restore-health-detail")).toHaveTextContent(
      "offline restored 1",
    );
    expect(rpc).toHaveBeenCalledWith("get_admin_restore_health_stats", { p_hours: 24 });
  });
});
