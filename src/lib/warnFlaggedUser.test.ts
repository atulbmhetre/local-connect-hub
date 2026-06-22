import { describe, expect, it, vi, beforeEach } from "vitest";
import { warnFlaggedUser } from "@/lib/warnFlaggedUser";
import { strings } from "@/lib/strings";

const {
  mockInvokeNotifyUser,
  mockSaveNotification,
  mockLogAdminAction,
  mockUsersUpdate,
  appUserLang,
  warnCount,
} = vi.hoisted(() => ({
  mockInvokeNotifyUser: vi.fn(),
  mockSaveNotification: vi.fn(),
  mockLogAdminAction: vi.fn(),
  mockUsersUpdate: vi.fn(async () => ({ error: null })),
  appUserLang: { value: "hi" as string | null },
  warnCount: { value: 0 },
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
          if (table === "users") {
            return { data: { warn_count: warnCount.value }, error: null };
          }
          return { data: null, error: null };
        }),
        update: vi.fn(() => ({
          eq: mockUsersUpdate,
        })),
      };
      return chain;
    },
  },
  invokeNotifyUser: mockInvokeNotifyUser,
}));

vi.mock("@/lib/notifications", () => ({
  saveNotification: mockSaveNotification,
}));

vi.mock("@/lib/adminAudit", () => ({
  logAdminAction: mockLogAdminAction,
}));

describe("warnFlaggedUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appUserLang.value = "hi";
    warnCount.value = 1;
  });

  it("writes FCM push and inbox row with Hindi copy for hi user", async () => {
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
    expect(mockSaveNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userPhone: "9876543210",
        title: strings.hi.warn_user_title,
        body: strings.hi.warn_user_inbox_body,
        type: "account_warning",
      }),
    );
    expect(mockLogAdminAction).toHaveBeenCalledWith("warn_user", "user", "9876543210");
  });
});
