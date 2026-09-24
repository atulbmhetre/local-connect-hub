import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
import { NotificationBell } from "@/components/NotificationBell";
import { resetUserNotificationsRealtimeForTests } from "@/lib/userNotificationsRealtime";
import { strings } from "@/lib/strings";

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

function PathProbe() {
  const location = useLocation();
  return <div data-testid="history-path">{location.pathname}</div>;
}

function renderBellOnHome() {
  window.history.replaceState({}, "", "/");
  return render(
    <BrowserRouter>
      <PathProbe />
      <NotificationBell />
      <Routes>
        <Route path="/" element={<div data-testid="home-screen">home</div>} />
        <Route path="/my-orders" element={<div data-testid="my-orders-screen">orders</div>} />
        <Route path="/feed" element={<div data-testid="feed-screen">feed</div>} />
      </Routes>
    </BrowserRouter>,
  );
}

describe("NotificationBell real history navigation", () => {
  beforeEach(() => {
    resetUserNotificationsRealtimeForTests();
    channelState.subscribed = false;
    notifications.value = [];
    vi.clearAllMocks();
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
    resetUserNotificationsRealtimeForTests();
  });

  async function openAndTap(title: string) {
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));
    expect(await screen.findByText(title)).toBeInTheDocument();
    fireEvent.click(screen.getByText(title));
  }

  it("navigates from / to /my-orders without overlay history.back resetting home", async () => {
    notifications.value = [
      {
        id: "n-orders",
        user_phone: "9876543210",
        type: "order_accepted",
        title: "Go to orders",
        body: "Body",
        route: "my-orders",
        route_params: null,
        is_informational: false,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    renderBellOnHome();
    expect(screen.getByTestId("history-path")).toHaveTextContent("/");
    await openAndTap("Go to orders");

    await waitFor(() => {
      expect(screen.getByTestId("history-path")).toHaveTextContent("/my-orders");
    });
    expect(screen.getByTestId("my-orders-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("home-screen")).not.toBeInTheDocument();
  });

  it("navigates from / to /feed without overlay history.back resetting home", async () => {
    notifications.value = [
      {
        id: "n-feed",
        user_phone: "9876543210",
        type: "feed_reply",
        title: "Go to feed",
        body: "Body",
        route: "feed",
        route_params: null,
        is_informational: false,
        is_read: false,
        read_at: null,
        created_at: new Date().toISOString(),
      },
    ];

    renderBellOnHome();
    expect(screen.getByTestId("history-path")).toHaveTextContent("/");
    await openAndTap("Go to feed");

    await waitFor(() => {
      expect(screen.getByTestId("history-path")).toHaveTextContent("/feed");
    });
    expect(screen.getByTestId("feed-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("home-screen")).not.toBeInTheDocument();
  });
});
