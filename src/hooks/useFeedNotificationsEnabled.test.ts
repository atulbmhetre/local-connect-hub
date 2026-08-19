import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFeedNotificationsEnabled } from "@/hooks/useFeedNotificationsEnabled";
import { strings } from "@/lib/strings";

const { mockRpc } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mockRpc },
}));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "feed-device-1",
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "9123456780",
}));

vi.mock("@/lib/language", () => ({
  useLanguage: () => ({ s: strings.en, lang: "en" as const }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/lib/webPush", () => ({
  requestWebPushFromUserGesture: vi.fn(async () => true),
}));

describe("useFeedNotificationsEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_user_device") {
        return {
          data: { feed_notifications_enabled: false },
          error: null,
        };
      }
      if (name === "set_user_device_feed_notifications") {
        return { data: args.p_enabled, error: null };
      }
      return { data: null, error: null };
    });
  });

  it("loads persisted feed_notifications_enabled from device row (native reload path)", async () => {
    const { result } = renderHook(() => useFeedNotificationsEnabled());

    await waitFor(() => {
      expect(result.current.enabled).toBe(false);
    });
    expect(mockRpc).toHaveBeenCalledWith("get_user_device", {
      p_user_phone: "9123456780",
      p_device_id: "feed-device-1",
    });
  });

  it("persists toggle via set_user_device_feed_notifications", async () => {
    mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "get_user_device") {
        return { data: { feed_notifications_enabled: true }, error: null };
      }
      if (name === "set_user_device_feed_notifications") {
        return { data: args.p_enabled, error: null };
      }
      return { data: null, error: null };
    });

    const { result } = renderHook(() => useFeedNotificationsEnabled());
    await waitFor(() => expect(result.current.enabled).toBe(true));

    await act(async () => {
      result.current.onCheckedChange(false);
    });

    await waitFor(() => {
      expect(mockRpc).toHaveBeenCalledWith("set_user_device_feed_notifications", {
        p_user_phone: "9123456780",
        p_device_id: "feed-device-1",
        p_enabled: false,
      });
    });
    expect(result.current.enabled).toBe(false);
  });
});
