import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { strings } from "@/lib/strings";
import { FirstOpenFlow } from "@/components/FirstOpenFlow";
import {
  getUserPhone,
  hasBeenWelcomed,
  markWelcomed,
  restoreVendorSession,
} from "@/lib/userIdentity";
import { captureError } from "@/lib/sentry";

const { mockUsersData, mockVendorStatus, mockRpc } = vi.hoisted(() => {
  let usersData: {
    total_orders: number;
    completed_orders: number;
    trust_score: number;
    warn_count: number;
    is_banned: boolean;
  } | null = null;
  let vendorStatus: {
    found: boolean;
    vendor_id: string | null;
    is_banned: boolean;
    is_active: boolean;
    discoverable: boolean;
    profile_status: string | null;
    deletion_requested_at: string | null;
    restore_allowed: boolean;
    deny_reason: string | null;
  } | null = null;

  const rpc = vi.fn(async (fnName: string) => {
    if (fnName === "lookup_user_by_phone") {
      if (usersData) {
        return { data: [usersData], error: null };
      }
      return { data: [], error: null };
    }
    if (fnName === "get_vendor_restore_status") {
      return {
        data: vendorStatus ?? {
          found: false,
          vendor_id: null,
          is_banned: false,
          is_active: false,
          discoverable: false,
          profile_status: null,
          deletion_requested_at: null,
          restore_allowed: false,
          deny_reason: "not_found",
        },
        error: null,
      };
    }
    if (fnName === "migrate_saved_vendors_phone" || fnName === "migrate_device_requests_phone") {
      return { data: null, error: null };
    }
    if (fnName === "log_firstopen_restore" || fnName === "ensure_user_device_link") {
      return { data: null, error: null };
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
    mockVendorStatus: {
      set: (
        value: {
          found: boolean;
          vendor_id: string | null;
          is_banned?: boolean;
          is_active?: boolean;
          discoverable?: boolean;
          profile_status?: string | null;
          deletion_requested_at?: string | null;
          restore_allowed?: boolean;
          deny_reason?: string | null;
        } | null,
      ) => {
        vendorStatus = value
          ? {
              found: value.found,
              vendor_id: value.vendor_id,
              is_banned: value.is_banned ?? false,
              is_active: value.is_active ?? true,
              discoverable: value.discoverable ?? true,
              profile_status: value.profile_status ?? "complete",
              deletion_requested_at: value.deletion_requested_at ?? null,
              restore_allowed: value.restore_allowed ?? true,
              deny_reason: value.deny_reason ?? null,
            }
          : null;
      },
    },
    mockRpc: rpc,
  };
});

vi.mock("@/lib/supabase", () => ({
  supabase: { from: vi.fn(), rpc: mockRpc },
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device-id",
}));

vi.mock("@/lib/sentry", () => ({
  captureError: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    requestPermissions: vi.fn(async () => ({ receive: "granted" })),
    register: vi.fn(),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
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
    mockVendorStatus.set(null);
    vi.clearAllMocks();
  });

  it("shows two-tier chooser on first open when not welcomed", () => {
    render(<WelcomeGate />);
    expect(screen.getByTestId("first-open-flow")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-im-new")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-returning")).toBeInTheDocument();
    expect(screen.queryByTestId("firstopen-vendor-btn")).not.toBeInTheDocument();
  });

  it("does not show restore prompt after markWelcomed()", () => {
    markWelcomed();
    render(<WelcomeGate />);
    expect(screen.queryByTestId("first-open-flow")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-screen")).toBeInTheDocument();
  });
});

function openRestore() {
  fireEvent.click(screen.getByTestId("firstopen-returning"));
}

describe("FirstOpenFlow restore", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsersData.set(null);
    mockVendorStatus.set(null);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores customer identity for a known phone", async () => {
    const onComplete = vi.fn();
    mockUsersData.set({ total_orders: 3 });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.firstopen_restore_found)).toBeInTheDocument();
    });
    expect(getUserPhone()).toBe("9876543210");
    expect(mockRpc).toHaveBeenCalledWith("get_vendor_restore_status", {
      p_phone: "9876543210",
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("shows no account found and requires a Continue tap (does not auto-advance)", async () => {
    const onComplete = vi.fn();

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9123456789" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByTestId("firstopen-restore-message")).toHaveTextContent(
        strings.en.firstopen_no_account,
      );
    });
    expect(screen.getByTestId("firstopen-no-account-continue")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();

    // Former auto-advance was 800ms — stay put well past that without a tap.
    await new Promise((r) => setTimeout(r, 1500));
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId("firstopen-restore-message")).toBeInTheDocument();
    expect(localStorage.getItem("aaspaas:user_phone")).toBeNull();

    fireEvent.click(screen.getByTestId("firstopen-no-account-continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  }, 10_000);

  it("restores vendor session for active vendor phone", async () => {
    const onComplete = vi.fn();
    mockVendorStatus.set({
      found: true,
      vendor_id: "vendor-test-123",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      restore_allowed: true,
      deny_reason: null,
    });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
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
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("restores offline vendor without requiring is_active", async () => {
    const onComplete = vi.fn();
    mockVendorStatus.set({
      found: true,
      vendor_id: "vendor-offline-1",
      is_active: false,
      discoverable: true,
      profile_status: "complete",
      restore_allowed: true,
      deny_reason: null,
    });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(localStorage.getItem("aaspaas:vendor_id")).toBe("vendor-offline-1");
    });
    expect(mockRpc).toHaveBeenCalledWith("log_firstopen_restore", {
      p_outcome: "success_vendor_offline",
      p_device_id: "test-device-id",
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 3000 });
  });

  it("restores hidden vendor (discoverable=false)", async () => {
    mockVendorStatus.set({
      found: true,
      vendor_id: "vendor-hidden-1",
      is_active: true,
      discoverable: false,
      profile_status: "complete",
      restore_allowed: true,
      deny_reason: null,
    });

    render(<FirstOpenFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(localStorage.getItem("aaspaas:vendor_id")).toBe("vendor-hidden-1");
    });
    expect(mockRpc).toHaveBeenCalledWith("log_firstopen_restore", {
      p_outcome: "success_vendor_hidden",
      p_device_id: "test-device-id",
    });
  });

  it("does not restore banned vendor session", async () => {
    mockUsersData.set({ total_orders: 1 });
    mockVendorStatus.set({
      found: true,
      vendor_id: "vendor-banned-1",
      is_banned: true,
      is_active: false,
      restore_allowed: false,
      deny_reason: "banned",
    });

    render(<FirstOpenFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(getUserPhone()).toBe("9876543210");
    });
    expect(localStorage.getItem("aaspaas:vendor_id")).toBeNull();
    expect(mockRpc).toHaveBeenCalledWith("log_firstopen_restore", {
      p_outcome: "denied_banned",
      p_device_id: "test-device-id",
    });
  });

  it("blocks restore for banned customer and does not save phone", async () => {
    const onComplete = vi.fn();
    mockUsersData.set({
      total_orders: 3,
      completed_orders: 1,
      trust_score: 10,
      warn_count: 2,
      is_banned: true,
    });
    mockVendorStatus.set({
      found: false,
      vendor_id: null,
      is_banned: false,
      is_active: false,
      discoverable: false,
      profile_status: null,
      deletion_requested_at: null,
      restore_allowed: false,
      deny_reason: "not_found",
    });

    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByTestId("firstopen-restore-message")).toHaveTextContent(
        strings.en.customer_account_banned,
      );
    });
    expect(getUserPhone()).toBeNull();
    expect(localStorage.getItem("aaspaas:user_phone")).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("log_firstopen_restore", {
      p_outcome: "denied_banned",
      p_device_id: "test-device-id",
    });
    expect(screen.getByTestId("first-open-flow")).toBeInTheDocument();
  });

  it("calls captureError on lookup failure", async () => {
    const lookupError = { message: "rpc failed" };
    mockRpc.mockImplementation(async (fnName: string) => {
      if (fnName === "lookup_user_by_phone") {
        return { data: null, error: lookupError };
      }
      if (fnName === "get_vendor_restore_status") {
        return {
          data: {
            found: false,
            vendor_id: null,
            is_banned: false,
            is_active: false,
            discoverable: false,
            profile_status: null,
            deletion_requested_at: null,
            restore_allowed: false,
            deny_reason: "not_found",
          },
          error: null,
        };
      }
      return { data: null, error: null };
    });

    render(<FirstOpenFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByTestId("firstopen-restore-message")).toHaveTextContent(
        strings.en.firstopen_restore_error,
      );
    });
    expect(captureError).toHaveBeenCalledWith(lookupError, {
      scope: "firstOpen.restore.lookup",
      phoneSuffix: "3210",
    });
  });

  it(
    "shows timeout message when restore lookup hangs (never resolves)",
    async () => {
      vi.useFakeTimers();
      mockRpc.mockImplementation(() => new Promise(() => {}));

      render(<FirstOpenFlow onComplete={vi.fn()} />);

      fireEvent.click(screen.getByTestId("firstopen-returning"));
      fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
        target: { value: "9876543210" },
      });
      fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

      // 3 attempts × 12s + backoff 1s + 2s
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
        await vi.advanceTimersByTimeAsync(1_000);
        await vi.advanceTimersByTimeAsync(12_000);
        await vi.advanceTimersByTimeAsync(2_000);
        await vi.advanceTimersByTimeAsync(12_000);
      });

      expect(screen.getByTestId("firstopen-restore-message")).toHaveTextContent(
        strings.en.firstopen_restore_timeout,
      );
      expect(screen.getByTestId("firstopen-restore-cta")).not.toBeDisabled();
      vi.useRealTimers();
    },
    60_000,
  );

  it("shows partial notice when migration RPCs fail", async () => {
    mockUsersData.set({ total_orders: 2 });
    mockRpc.mockImplementation(async (fnName: string) => {
      if (fnName === "lookup_user_by_phone") {
        return {
          data: [
            {
              total_orders: 2,
              completed_orders: 0,
              trust_score: 75,
              warn_count: 0,
              is_banned: false,
            },
          ],
          error: null,
        };
      }
      if (fnName === "get_vendor_restore_status") {
        return {
          data: {
            found: false,
            vendor_id: null,
            is_banned: false,
            is_active: false,
            discoverable: false,
            profile_status: null,
            deletion_requested_at: null,
            restore_allowed: false,
            deny_reason: "not_found",
          },
          error: null,
        };
      }
      if (fnName === "migrate_saved_vendors_phone") {
        return { data: null, error: { message: "boom" } };
      }
      return { data: null, error: null };
    });

    render(<FirstOpenFlow onComplete={vi.fn()} />);

    fireEvent.click(screen.getByTestId("firstopen-returning"));
    fireEvent.change(screen.getByPlaceholderText("98765 43210"), {
      target: { value: "9876543210" },
    });
    fireEvent.click(screen.getByTestId("firstopen-restore-cta"));

    await waitFor(() => {
      expect(screen.getByText(strings.en.firstopen_restore_partial)).toBeInTheDocument();
    });
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

describe("orphan firstopen_restore_skip", () => {
  it("is not present on string catalogs", () => {
    expect("firstopen_restore_skip" in strings.en).toBe(false);
    expect("firstopen_restore_skip" in strings.hi).toBe(false);
    expect("firstopen_restore_skip" in strings.mr).toBe(false);
  });
});

describe("FirstOpenFlow two-tier navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    mockUsersData.set(null);
    mockVendorStatus.set(null);
    vi.clearAllMocks();
  });

  it("new → use as customer completes without phone", async () => {
    const onComplete = vi.fn();
    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-im-new"));
    expect(screen.getByTestId("firstopen-vendor-btn")).toBeInTheDocument();
    expect(screen.getByTestId("firstopen-use-as-customer")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("firstopen-use-as-customer"));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(localStorage.getItem("aaspaas:user_phone")).toBeNull();
  });

  it("new → register business calls onVendorRegister", () => {
    const onVendorRegister = vi.fn();
    render(<FirstOpenFlow onComplete={vi.fn()} onVendorRegister={onVendorRegister} />);

    fireEvent.click(screen.getByTestId("firstopen-im-new"));
    fireEvent.click(screen.getByTestId("firstopen-vendor-btn"));
    expect(onVendorRegister).toHaveBeenCalled();
  });

  it("hardware-style back pops new_options to chooser without completing", () => {
    const onComplete = vi.fn();
    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-im-new"));
    expect(screen.getByTestId("firstopen-use-as-customer")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("firstopen-new-options-back"));
    expect(screen.getByTestId("firstopen-im-new")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(hasBeenWelcomed()).toBe(false);
  });

  it("restore back returns to chooser without marking welcomed", () => {
    render(<FirstOpenFlow onComplete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("firstopen-returning"));
    expect(screen.getByTestId("firstopen-restore-cta")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("firstopen-restore-back"));
    expect(screen.getByTestId("firstopen-im-new")).toBeInTheDocument();
    expect(hasBeenWelcomed()).toBe(false);
  });

  it("restore copy asks for mobile number without OTP wording", () => {
    render(<FirstOpenFlow onComplete={vi.fn()} />);
    fireEvent.click(screen.getByTestId("firstopen-returning"));
    expect(screen.getByText(strings.en.firstopen_restore_body)).toBeInTheDocument();
    expect(strings.en.firstopen_restore_body.toLowerCase()).not.toContain("otp");
    expect(strings.en.firstopen_restore_title.toLowerCase()).not.toContain("otp");
  });
});

describe("FirstOpenFlow notification permission", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("Allow always calls OS requestPermissions even without a phone", async () => {
    const { Capacitor } = await import("@capacitor/core");
    const { PushNotifications } = await import("@capacitor/push-notifications");
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: "granted",
    } as never);

    const onComplete = vi.fn();
    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-im-new"));
    fireEvent.click(screen.getByTestId("firstopen-use-as-customer"));

    await waitFor(() => {
      expect(screen.getByTestId("firstopen-notif-allow")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("firstopen-notif-allow"));

    await waitFor(() => {
      expect(PushNotifications.requestPermissions).toHaveBeenCalled();
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(getUserPhone()).toBeNull();

    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });
});

describe("FirstOpenFlow back bridge", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("tryHandleFirstOpenBack pops stack instead of leaving a blank done state", async () => {
    const { act } = await import("@testing-library/react");
    const { tryHandleFirstOpenBack } = await import("@/lib/firstOpenBackBridge");
    const onComplete = vi.fn();
    render(<FirstOpenFlow onComplete={onComplete} />);

    fireEvent.click(screen.getByTestId("firstopen-im-new"));
    expect(screen.getByTestId("firstopen-use-as-customer")).toBeInTheDocument();

    await act(async () => {
      expect(tryHandleFirstOpenBack()).toBe(true);
    });

    await waitFor(() => {
      expect(screen.getByTestId("firstopen-im-new")).toBeInTheDocument();
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByTestId("first-open-flow")).toBeInTheDocument();
    expect(screen.queryByTestId("firstopen-use-as-customer")).not.toBeInTheDocument();
  });
});
