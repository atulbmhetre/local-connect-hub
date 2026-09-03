import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import {
  NotificationBell,
  NOTIFICATION_BELL_POLL_MS,
} from "@/components/NotificationBell";
import { supabase } from "@/lib/supabase";
import { resetUserNotificationsRealtimeForTests } from "@/lib/userNotificationsRealtime";
import { strings } from "@/lib/strings";
import { navigateFromNotification } from "@/lib/notificationNavigation";

const { notifications, mockRpc, captureError, channelState } = vi.hoisted(() => {
  const rows = {
    value: [] as Array<{
      id: string;
      user_phone: string;
      type: string;
      title: string;
      body: string;
      route: string | null;
      route_params: Record<string, string> | null;
      is_informational: boolean;
      is_read: boolean;
      read_at: string | null;
      created_at: string;
    }>,
  };
  return {
    notifications: rows,
    mockRpc: vi.fn(),
    captureError: vi.fn(),
    channelState: { subscribed: false },
  };
});

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => {
  const channel = {
    on: vi.fn(function (this: { on: unknown; subscribe: unknown }) {
      if (channelState.subscribed) {
        throw new Error("cannot add `postgres_changes` callbacks after `subscribe()`.");
      }
      return this;
    }),
    subscribe: vi.fn(function (this: { on: unknown; subscribe: unknown }) {
      channelState.subscribed = true;
      return this;
    }),
  };
  return {
    supabase: {
      rpc: mockRpc,
      channel: vi.fn(() => channel),
      removeChannel: vi.fn(() => {
        channelState.subscribed = false;
      }),
    },
  };
});

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
  USER_PHONE_CHANGED_EVENT: "aaspaas:user_phone_changed",
  ensureUserDeviceLink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/lib/notificationNavigation", () => ({
  navigateFromNotification: vi.fn(),
}));

describe("NotificationBell", () => {
  beforeEach(() => {
    resetUserNotificationsRealtimeForTests();
    channelState.subscribed = false;
    notifications.value = [];
    vi.clearAllMocks();
    vi.useRealTimers();
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_user_unread_notification_count") {
        return {
          data: notifications.value.filter((n) => !n.is_read).length,
          error: null,
        };
      }
      if (name === "get_user_notifications") {
        return { data: notifications.value, error: null };
      }
      return { data: null, error: null };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUserNotificationsRealtimeForTests();
  });

  it("does not throw when the sidebar bell and the page bell mount together", () => {
    expect(() =>
      render(
        <>
          <NotificationBell />
          <NotificationBell layout="nav" navLabel="Notifications" />
        </>,
      ),
    ).not.toThrow();
    expect(supabase.channel).toHaveBeenCalledTimes(1);
    expect(supabase.channel).toHaveBeenCalledWith("user-notifications-9876543210");
  });

  it("shows empty state copy when there are no notifications", async () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));

    await waitFor(() => {
      expect(screen.getByText(strings.en.notif_bell_empty_title)).toBeInTheDocument();
    });
  });

  it("dismiss removes item from the list", async () => {
    notifications.value = [
      {
        id: "n1",
        user_phone: "9876543210",
        type: "order_update",
        title: "Order update",
        body: "Body",
        route: null,
        route_params: null,
        is_informational: false,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));

    await waitFor(() => {
      expect(screen.getByText("Order update")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_dismiss_aria));

    await waitFor(() => {
      expect(screen.queryByText("Order update")).not.toBeInTheDocument();
    });
    expect(mockRpc).toHaveBeenCalledWith("delete_user_notification", {
      p_user_phone: "9876543210",
      p_device_id: "test-device",
      p_notification_id: "n1",
    });
  });

  it("updates badge via poll alone when Realtime never fires (OTP-off)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    notifications.value = [];
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_user_unread_notification_count") {
        return {
          data: notifications.value.filter((n) => !n.is_read).length,
          error: null,
        };
      }
      if (name === "get_user_notifications") {
        return { data: notifications.value, error: null };
      }
      return { data: null, error: null };
    });

    render(<NotificationBell />);

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("get_user_unread_notification_count", {
        p_user_phone: "9876543210",
        p_device_id: "test-device",
      });
    });
    expect(screen.queryByTestId("notification-bell-badge")).not.toBeInTheDocument();

    // Simulate server-side insert that Realtime cannot deliver under OTP-off.
    notifications.value = [
      {
        id: "poll-1",
        user_phone: "9876543210",
        type: "order_update",
        title: "Polled",
        body: "Body",
        route: null,
        route_params: null,
        is_informational: false,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTIFICATION_BELL_POLL_MS);
    });

    await waitFor(() => {
      expect(screen.getByTestId("notification-bell-btn")).toHaveAttribute(
        "data-unread-count",
        "1",
      );
    });
    expect(screen.getByTestId("notification-bell-badge")).toHaveTextContent("1");
  });

  it("renders distinct load-error UI and captures tray RPC failure", async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_user_unread_notification_count") {
        return { data: 0, error: null };
      }
      if (name === "get_user_notifications") {
        return { data: null, error: { message: "get_user_notifications failed" } };
      }
      return { data: null, error: null };
    });

    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));

    expect(await screen.findByTestId("notification-bell-load-error")).toBeVisible();
    expect(screen.getByText(strings.en.notif_bell_load_error)).toBeInTheDocument();
    expect(screen.queryByText(strings.en.notif_bell_empty_title)).not.toBeInTheDocument();

    await waitFor(() => {
      expect(captureError).toHaveBeenCalled();
    });
    expect(captureError.mock.calls.some((c) => c[1]?.operation === "get_user_notifications")).toBe(
      true,
    );
  });

  it("uses unread-count RPC for badge and does not refresh tray while sheet is closed", async () => {
    notifications.value = Array.from({ length: 3 }, (_, i) => ({
      id: `n${i}`,
      user_phone: "9876543210",
      type: "order_update",
      title: `T${i}`,
      body: "Body",
      route: null,
      route_params: null,
      is_informational: false,
      is_read: false,
      read_at: null,
      created_at: new Date().toISOString(),
    }));
    mockRpc.mockImplementation(async (name: string) => {
      if (name === "get_user_unread_notification_count") {
        return { data: 105, error: null };
      }
      if (name === "get_user_notifications") {
        return { data: notifications.value, error: null };
      }
      return { data: null, error: null };
    });

    render(<NotificationBell />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-bell-btn")).toHaveAttribute(
        "data-unread-count",
        "105",
      );
    });
    expect(screen.getByTestId("notification-bell-badge")).toHaveTextContent("99+");

    const trayCalls = mockRpc.mock.calls.filter((c) => c[0] === "get_user_notifications");
    expect(trayCalls.length).toBe(0);
  });

  it("hides the header icon at lg so the desktop sidebar owns notifications", () => {
    render(<NotificationBell />);
    expect(screen.getByTestId("notification-bell-btn").className).toContain("lg:hidden");
  });

  it("does not hide the sidebar Notifications row at lg", () => {
    render(<NotificationBell layout="nav" navLabel="Notifications" />);
    expect(screen.getByTestId("desktop-nav-notifications").className).not.toContain("lg:hidden");
  });

  it("expands a long body in the tray without navigating away", async () => {
    const longBody =
      "Vendor confirmed your order and shared extra notes about timing, access, and payment so you can read the full message here.";
    notifications.value = [
      {
        id: "n-long",
        user_phone: "9876543210",
        type: "order_update",
        title: "Order update",
        body: longBody,
        route: "/orders",
        route_params: null,
        is_informational: false,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));

    const body = await screen.findByText(longBody);
    expect(body.className).toContain("line-clamp-2");

    fireEvent.click(screen.getByRole("button", { name: strings.en.notif_read_more }));
    expect(body.className).not.toContain("line-clamp-2");
    expect(navigateFromNotification).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: strings.en.notif_show_less })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Order update"));
    await waitFor(() => {
      expect(navigateFromNotification).toHaveBeenCalled();
    });
  });
});
