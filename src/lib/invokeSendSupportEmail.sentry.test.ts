import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureError, invoke } = vi.hoisted(() => ({
  captureError: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ data: { ok: true, emailed: true }, error: null }),
}));

vi.mock("@/lib/sentry", () => ({
  captureError,
  addBreadcrumb: vi.fn(),
  phoneSuffix: (phone: string) => phone.slice(-4),
}));

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

vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");

describe("invokeSendSupportEmail captureError", () => {
  beforeEach(() => {
    captureError.mockClear();
    invoke.mockClear();
    invoke.mockResolvedValue({ data: { ok: true, emailed: true }, error: null });
  });

  it("captures invoke transport errors with kind and phoneSuffix, not full phone", async () => {
    const { invokeSendSupportEmail } = await import("@/lib/supabase");
    const err = { message: "FunctionsHttpError" };
    invoke.mockResolvedValueOnce({ data: null, error: err });

    const result = await invokeSendSupportEmail({
      kind: "contact",
      message: "help",
      user_phone: "9876543210",
      vendor_id: "v-1",
    });

    expect(result).toEqual({ ok: false, error: "FunctionsHttpError" });
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        scope: "invokeSendSupportEmail",
        kind: "contact",
        vendorId: "v-1",
        phoneSuffix: "3210",
      }),
    );
    expect(JSON.stringify(captureError.mock.calls[0][1])).not.toContain("9876543210");
  });

  it("captures function body failures when result.ok is false", async () => {
    const { invokeSendSupportEmail } = await import("@/lib/supabase");
    invoke.mockResolvedValueOnce({ data: { ok: false, error: "smtp_down" }, error: null });

    const result = await invokeSendSupportEmail({
      kind: "feedback",
      message: "nps",
    });

    expect(result).toEqual({ ok: false, error: "smtp_down" });
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "smtp_down" }),
      expect.objectContaining({
        scope: "invokeSendSupportEmail",
        kind: "feedback",
        vendorId: null,
      }),
    );
  });

  it("captures thrown invoke failures", async () => {
    const { invokeSendSupportEmail } = await import("@/lib/supabase");
    invoke.mockRejectedValueOnce(new Error("network_down"));

    const result = await invokeSendSupportEmail({
      kind: "contact",
      message: "help",
    });

    expect(result).toEqual({ ok: false, error: "network_down" });
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "network_down" }),
      expect.objectContaining({ scope: "invokeSendSupportEmail", kind: "contact" }),
    );
  });

  it("does not captureError on success", async () => {
    const { invokeSendSupportEmail } = await import("@/lib/supabase");
    const result = await invokeSendSupportEmail({
      kind: "feedback",
      message: "great",
    });
    expect(result).toEqual({ ok: true, emailed: true, id: null });
    expect(captureError).not.toHaveBeenCalled();
  });
});
