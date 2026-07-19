import { describe, expect, it, vi, beforeEach } from "vitest";
import { applyVendorWaiveoff } from "@/lib/applyVendorWaiveoff";
import { strings } from "@/lib/strings";

const {
  mockInvokeNotifyVendor,
  mockLogAdminAction,
  mockApplyWaiveoffRpc,
  appUserLang,
} = vi.hoisted(() => ({
  mockInvokeNotifyVendor: vi.fn(),
  mockLogAdminAction: vi.fn(),
  mockApplyWaiveoffRpc: vi.fn(async () => ({ data: null, error: null })),
  appUserLang: { value: "hi" as string | null },
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "8888169446",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (fnName: string, _params: unknown) => {
      if (fnName === "admin_apply_vendor_waiveoff") {
        return mockApplyWaiveoffRpc();
      }
      if (fnName === "admin_get_user_lang") {
        return Promise.resolve({ data: appUserLang.value ?? "en", error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
  invokeNotifyVendor: mockInvokeNotifyVendor,
}));

vi.mock("@/lib/adminAudit", () => ({
  logAdminAction: mockLogAdminAction,
}));

const ALL_LANGS_ENABLED = {
  localizationEnabled: true,
  langHindiEnabled: true,
  langMarathiEnabled: true,
};

const VENDOR = { id: "vendor-1", phone: "9876543210" };

describe("applyVendorWaiveoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appUserLang.value = "hi";
    mockApplyWaiveoffRpc.mockResolvedValue({ data: null, error: null });
  });

  it("sends the waive-off push with Hindi copy for a hi vendor", async () => {
    const result = await applyVendorWaiveoff(VENDOR, 50, 3, ALL_LANGS_ENABLED);

    expect(result).toEqual({ ok: true });
    expect(mockInvokeNotifyVendor).toHaveBeenCalledWith({
      vendor_id: "vendor-1",
      notification_title: strings.hi.waiveoff_push_title,
      message: strings.hi.waiveoff_push_body
        .replace("{percent}", "50")
        .replace("{months}", "3"),
      type: "subscription_update",
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      "update_config",
      "vendor",
      "vendor-1",
      "waiveoff:50%x3months",
      undefined,
    );
  });

  it("falls back to English copy when localization is disabled", async () => {
    const result = await applyVendorWaiveoff(VENDOR, 25, 2, {
      localizationEnabled: false,
      langHindiEnabled: true,
      langMarathiEnabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mockInvokeNotifyVendor).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_title: strings.en.waiveoff_push_title,
        message: strings.en.waiveoff_push_body
          .replace("{percent}", "25")
          .replace("{months}", "2"),
      }),
    );
  });

  it("uses Marathi copy for a mr vendor", async () => {
    appUserLang.value = "mr";
    await applyVendorWaiveoff(VENDOR, 10, 1, ALL_LANGS_ENABLED);
    expect(mockInvokeNotifyVendor).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_title: strings.mr.waiveoff_push_title,
      }),
    );
  });

  it("returns the RPC error and sends no push when apply fails", async () => {
    mockApplyWaiveoffRpc.mockResolvedValue({
      data: null,
      error: { message: "unauthorized" } as never,
    });

    const result = await applyVendorWaiveoff(VENDOR, 50, 3, ALL_LANGS_ENABLED);

    expect(result).toEqual({ ok: false, error: "unauthorized" });
    expect(mockInvokeNotifyVendor).not.toHaveBeenCalled();
    expect(mockLogAdminAction).not.toHaveBeenCalled();
  });
});
