import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureError, addBreadcrumb, invoke } = vi.hoisted(() => ({
  captureError: vi.fn(),
  addBreadcrumb: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }),
}));

vi.mock("@/lib/sentry", () => ({ captureError, addBreadcrumb, phoneSuffix: (phone: string) => phone.slice(-4) }));

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
    addBreadcrumb.mockClear();
    invoke.mockClear();
    invoke.mockResolvedValue({ data: { ok: true }, error: null });
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
    expect(captureError.mock.calls[0][1]?.phoneSuffix).toBe("9999");
    expect(captureError.mock.calls[0][1]?.userPhone).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(
      "notify-user",
      expect.objectContaining({
        body: expect.objectContaining({ type: "payment_confirmed" }),
      }),
    );
  });

  it("captureError when invokeNotifyUser invoke fails", async () => {
    const { invokeNotifyUser } = await import("@/lib/supabase");
    invoke.mockResolvedValueOnce({ data: null, error: new Error("notify-user failed") });
    invokeNotifyUser(
      {
        user_phone: "9876543210",
        title: "t",
        body: "b",
        type: "order_accepted",
        route: "my-orders",
        order_id: "req-1",
      },
      { source: "order_accept", request_id: "req-1" },
    );
    await vi.waitFor(() => {
      expect(captureError).toHaveBeenCalled();
    });
    expect(String(captureError.mock.calls[0][0])).toContain("notify-user failed");
    expect(captureError.mock.calls[0][1]?.phoneSuffix).toBe("3210");
    expect(captureError.mock.calls[0][1]?.source).toBe("order_accept");
    expect(captureError.mock.calls[0][1]?.request_id).toBe("req-1");
    expect(addBreadcrumb).toHaveBeenCalledWith(
      "invokeNotifyUser.invoke",
      expect.objectContaining({
        source: "order_accept",
        type: "order_accepted",
        request_id: "req-1",
      }),
    );
    expect(addBreadcrumb).toHaveBeenCalledWith(
      "invokeNotifyUser.failure",
      expect.objectContaining({ request_id: "req-1" }),
    );
  });

  it("captureError when invokeNotifyVendor invoke fails", async () => {
    const { invokeNotifyVendor } = await import("@/lib/supabase");
    invoke.mockResolvedValueOnce({ data: null, error: new Error("notify-vendor failed") });
    await invokeNotifyVendor(
      {
        vendor_id: "v1",
        type: "new_order",
        route: "vendor",
        notification_title: "t",
        message: "b",
        request_id: "req-2",
      },
      { source: "order_accept", request_id: "req-2" },
    );
    expect(captureError).toHaveBeenCalled();
    expect(String(captureError.mock.calls[0][0])).toContain("notify-vendor failed");
    expect(addBreadcrumb).toHaveBeenCalledWith(
      "invokeNotifyVendor.failure",
      expect.objectContaining({ request_id: "req-2" }),
    );
  });
});
