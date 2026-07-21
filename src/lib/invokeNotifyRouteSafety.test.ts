import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureError, invoke } = vi.hoisted(() => ({
  captureError: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/deviceId", () => ({
  getDeviceId: () => "test-device",
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    functions: { invoke },
    auth: {},
    realtime: { params: {} },
  }),
}));

// Must set before importing supabase (module throws without these).
vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");

describe("invokeNotify route safety net", () => {
  beforeEach(() => {
    captureError.mockClear();
    invoke.mockClear();
  });

  it("captureError when invokeNotifyVendor is called without route, still sends", async () => {
    const { invokeNotifyVendor } = await import("@/lib/supabase");
    await invokeNotifyVendor({
      vendor_id: "v1",
      type: "category_approved",
      notification_title: "t",
      message: "b",
    });
    expect(captureError).toHaveBeenCalled();
    expect(String(captureError.mock.calls[0][0])).toContain("missing route");
    expect(captureError.mock.calls[0][1]?.notificationType).toBe("category_approved");
    expect(invoke).toHaveBeenCalledWith(
      "notify-vendor",
      expect.objectContaining({
        body: expect.objectContaining({
          record: expect.objectContaining({ vendor_id: "v1", type: "category_approved" }),
        }),
      }),
    );
  });

  it("does not captureError when invokeNotifyVendor includes route", async () => {
    const { invokeNotifyVendor } = await import("@/lib/supabase");
    captureError.mockClear();
    await invokeNotifyVendor({
      vendor_id: "v1",
      type: "category_approved",
      route: "settings",
      notification_title: "t",
      message: "b",
    });
    expect(captureError).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalled();
  });

  it("captureError when invokeNotifyUser is called without route, still sends", async () => {
    const { invokeNotifyUser } = await import("@/lib/supabase");
    captureError.mockClear();
    invokeNotifyUser({
      user_phone: "9999999999",
      title: "t",
      body: "b",
      type: "payment_confirmed",
    });
    expect(captureError).toHaveBeenCalled();
    expect(String(captureError.mock.calls[0][0])).toContain("missing route");
    expect(captureError.mock.calls[0][1]?.notificationType).toBe("payment_confirmed");
    expect(invoke).toHaveBeenCalledWith(
      "notify-user",
      expect.objectContaining({
        body: expect.objectContaining({ type: "payment_confirmed" }),
      }),
    );
  });
});
