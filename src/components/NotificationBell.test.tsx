import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NotificationBell } from "@/components/NotificationBell";
import { strings } from "@/lib/strings";

const { notifications, mockDelete, loadIdRef } = vi.hoisted(() => {
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
  const mockDelete = vi.fn().mockResolvedValue({ error: null });
  let loadId = 0;

  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    delete: vi.fn(() => ({ eq: mockDelete })),
    update: vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) })),
    maybeSingle: vi.fn(),
  };

  return {
    notifications: rows,
    mockDelete,
    loadIdRef: {
      bump: () => ++loadId,
      get: () => loadId,
    },
    getChain: () => chain,
  };
});

vi.mock("@/lib/supabase", () => {
  const chain = {
    select: vi.fn(function select() {
      return chain;
    }),
    eq: vi.fn(function eq() {
      return chain;
    }),
    is: vi.fn(async function is() {
      return { count: 0, error: null };
    }),
    order: vi.fn(function order() {
      return chain;
    }),
    limit: vi.fn(async function limit() {
      return { data: notifications.value, error: null };
    }),
    delete: vi.fn(() => ({ eq: mockDelete })),
    update: vi.fn(() => {
      const updateChain = {
        eq: vi.fn(function eq() {
          return updateChain;
        }),
        then: (cb: (r: { error: null }) => void) => {
          cb({ error: null });
          return Promise.resolve({ error: null });
        },
      };
      return updateChain;
    }),
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn(),
    })),
    removeChannel: vi.fn(),
  };

  return {
    supabase: {
      from: vi.fn(() => chain),
      channel: chain.channel,
      removeChannel: chain.removeChannel,
    },
  };
});

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9876543210",
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
    notifications.value = [];
    vi.clearAllMocks();
  });

  it("shows empty state copy when there are no notifications", async () => {
    render(<NotificationBell />);
    fireEvent.click(screen.getByLabelText(strings.en.notif_bell_aria_label));

    await waitFor(() => {
      expect(screen.getByText(strings.en.notif_bell_empty_title)).toBeInTheDocument();
    });
    expect(screen.getByText(strings.en.notif_bell_empty_title)).toBeInTheDocument();
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
    expect(mockDelete).toHaveBeenCalled();
  });
});
