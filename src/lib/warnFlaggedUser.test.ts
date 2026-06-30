import { describe, expect, it, vi, beforeEach } from "vitest";
import { warnFlaggedUser } from "@/lib/warnFlaggedUser";
import { strings } from "@/lib/strings";

const {
  mockInvokeNotifyUser,
  mockLogAdminAction,
  mockAdminWarnUser,
  appUserLang,
} = vi.hoisted(() => ({
  mockInvokeNotifyUser: vi.fn(),
  mockLogAdminAction: vi.fn(),
  mockAdminWarnUser: vi.fn(async () => ({ data: 2, error: null })),
  appUserLang: { value: "hi" as string | null },
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => "8888169446",
}));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        limit: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => {
          if (table === "app_users") {
            return { data: { lang: appUserLang.value }, error: null };
          }
          return { data: null, error: null };
        }),
      };
      return chain;
    },
    rpc: (fnName: string, _params: unknown) => {
      if (fnName === "admin_get_user_lang") {
        return Promise.resolve({ data: appUserLang.value ?? "en", error: null });
      }
      if (fnName === "admin_warn_user") {
        return mockAdminWarnUser();
      }
      return Promise.resolve({ data: null, error: null });
    },
  },
  invokeNotifyUser: mockInvokeNotifyUser,
}));

vi.mock("@/lib/adminAudit", () => ({
  logAdminAction: mockLogAdminAction,
}));

describe("warnFlaggedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appUserLang.value = "hi";
  });

  it("sends FCM push with Hindi copy for hi user", async () => {
    const result = await warnFlaggedUser("9876543210", {
      localizationEnabled: true,
      langHindiEnabled: true,
      langMarathiEnabled: true,
    });

    expect(result).toEqual({ ok: true });
    expect(mockInvokeNotifyUser).toHaveBeenCalledWith({
      user_phone: "9876543210",
      title: strings.hi.warn_user_title,
      body: strings.hi.warn_user_push_body,
      type: "account_warning",
    });
    expect(mockLogAdminAction).toHaveBeenCalledWith("warn_user", "user", "9876543210");
  });
});
