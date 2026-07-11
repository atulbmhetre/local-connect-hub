import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { strings } from "@/lib/strings";
import { FirstOpenFlow } from "@/components/FirstOpenFlow";
import {
  getUserPhone,
  hasBeenWelcomed,
  markWelcomed,
  restoreVendorSession,
} from "@/lib/userIdentity";

const { mockUsersData, mockVendorsData, mockFrom, mockRpc } = vi.hoisted(() => {
  let usersData: {
    total_orders: number;
    completed_orders: number;
    trust_score: number;
    warn_count: number;
    is_banned: boolean;
  } | null = null;
  let vendorsData: {
    id: string;
    is_active: boolean;
    deletion_requested_at: string | null;
  } | null = null;

  const from = vi.fn((table: string) => {
    const chain = {
      select: vi.fn(function select() {
        return chain;
      }),
      eq: vi.fn(function eq() {
        return chain;
      }),
      or: vi.fn(async function or() {
        return { error: null };
      }),
      update: vi.fn(function update() {
        return chain;
      }),
      maybeSingle: vi.fn(async function maybeSingle() {
        if (table === "vendors") return { data: vendorsData, error: null };
        return { data: null, error: null };
      }),
    };
    return chain;
  });

  const rpc = vi.fn(async (fnName: string) => {
    if (fnName === "lookup_user_by_phone") {
      if (usersData) {
        return { data: [usersData], error: null };
      }
      return { data: [], error: null };
    }
    return { data: null, error: null };
  });

  return {
    mockUsersData: {
      set: (
        value: {
          total_orders: number;
          completed_orders?: number;
          trust_score?: number;
          warn_count?: number;
          is_banned?: boolean;
        } | null,
      ) => {
        usersData = value
          ? {
              total_orders: value.total_orders,
              completed_orders: value.completed_orders ?? 0,
              trust_score: value.trust_score ?? 75,
              warn_count: value.warn_count ?? 0,
              is_banned: value.is_banned ?? false,
            }
          : null;
      },
    },
    mockVendorsData: {
      set: (
        value: {
          id: string;
          is_active: boolean;
          deletion_requested_at: string | null;
        } | null,
      ) => {
        vendorsData = value;
      },
    },
    mockFrom: from,
    mockRpc: rpc,
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { from: mockFrom, rpc: mockRpc },
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device-id",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    requestPermissions: vi.fn(),
    register: vi.fn(),
  },
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const, setLang: () => {} }),
}));

function WelcomeGate({ onComplete }: { onComplete?: () => void }) {
  const [welcomed, setWelcomed] = useState(() => hasBeenWelcomed());

  const handleComplete = () => {
    markWelcomed();
    setWelcomed(true);
    onComplete?.();
  };

  return (
    <>
      <div data-testid="home-screen">Home</div>
      {!welcomed && <FirstOpenFlow onComplete={handleComplete} />}
    </>
  );
}

describe("first open welcome gate", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsersData.set(null);
    mockVendorsData.set(null);
    vi.clearAllMocks();
  });

  it("shows restore prompt on first open when not welcomed", () => {
    render(<WelcomeGate />);
    expect(screen.getByTestId("first-open-flow")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-vendor-btn")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-restore-skip")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-restore-entry")).toBeInTheDocument();
  });

  it("does not show restore prompt after markWelcomed()", () => {
    markWelcomed();
    render(<WelcomeGate />);
    expect(screen.queryByTestId("first-open-flow")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-screen")).toBeInTheDocument();
  });
});

describe("FirstOpenFlow restore", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsersData.set(null);
    mockVendorsData.set(null);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores customer identity for a known phone", async () => {
    const onComplete = vi.fn();
    mockUsersData.set({ total_orders: 3 });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-restore-entry"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.firstopen_restore_found)).toBeInTheDocument();
    });
    expect(getUserPhone()).toBe("9876543210");
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });

  it("shows no account found and completes for unknown phone", async () => {
    const onComplete = vi.fn();

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-restore-entry"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9123456789" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    // Web path sets no-account copy then immediately completes (non-native skips notification step).
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(localStorage.getItem("aaspaas:user_phone")).toBeNull();
  }, 10_000);

  it("restores vendor session for active vendor phone", async () => {
    const onComplete = vi.fn();
    mockVendorsData.set({
      id: "vendor-test-123",
      is_active: true,
      deletion_requested_at: null,
    });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-restore-entry"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.firstopen_restore_found)).toBeInTheDocument();
    });

    expect(localStorage.getItem("aaspaas:role")).toBe("vendor");
    expect(localStorage.getItem("aaspaas:vendor_active")).toBe("1");
    expect(localStorage.getItem("aaspaas:vendor_id")).toBe("vendor-test-123");
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  });
});

describe("restoreVendorSession", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("sets vendor role and active flag in storage", () => {
    restoreVendorSession("vendor-abc");
    expect(localStorage.getItem("aaspaas:role")).toBe("vendor");
    expect(localStorage.getItem("aaspaas:vendor_active")).toBe("1");
    expect(localStorage.getItem("aaspaas:vendor_id")).toBe("vendor-abc");
  });
});
