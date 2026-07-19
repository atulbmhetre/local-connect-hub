import { beforeEach, describe, expect, it, vi } from "vitest";
import { strings } from "@/lib/strings";

const rpcMock = vi.fn();
const notifyAdminMock = vi.fn();
const toastErrorMock = vi.fn();
const getUserPhoneMock = vi.fn(() => "9900011111");

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
  invokeNotifyAdmin: (...args: unknown[]) => notifyAdminMock(...args),
}));

vi.mock("@/lib/userIdentity", () => ({
  getUserPhone: () => getUserPhoneMock(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

import {
  checkAndNotifyAdminGreenReady,
  checkAndNotifyAdminCategoryGreenReady,
} from "./vendorGreenReady";

describe("checkAndNotifyAdminGreenReady — promote failures visible, promotion notifies admin", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    notifyAdminMock.mockReset();
    toastErrorMock.mockReset();
    getUserPhoneMock.mockReset();
    getUserPhoneMock.mockReturnValue("9900011111");
  });

  it("skips silently when no vendor phone is available (customer-initiated path)", async () => {
    getUserPhoneMock.mockReturnValue(null);

    const promoted = await checkAndNotifyAdminGreenReady("vendor-1", { shopName: "Atul Mess" });

    expect(promoted).toBe(false);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("surfaces a visible error toast when the promote RPC fails (no silent swallow)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });

    const promoted = await checkAndNotifyAdminGreenReady("vendor-1", {
      shopName: "Atul Mess",
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      strings.en.vendor_green_promote_failed,
      expect.objectContaining({ description: "boom" }),
    );
    expect(notifyAdminMock).not.toHaveBeenCalled();
  });

  it("sends the translated admin_green_ready notification when promotion actually happens", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });

    const promoted = await checkAndNotifyAdminGreenReady("vendor-1", {
      shopName: "Atul Mess",
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("vendor_promote_green_pending", {
      p_vendor_id: "vendor-1",
      p_vendor_phone: "9900011111",
    });
    expect(notifyAdminMock).toHaveBeenCalledTimes(1);
    const [title, body, options] = notifyAdminMock.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(title).toBe(strings.en.admin_green_ready_title);
    expect(body).toBe(strings.en.admin_green_ready_body.replace("{shop}", "Atul Mess"));
    expect(body).toContain("Atul Mess");
    expect(options).toMatchObject({
      type: "vendor_green_ready",
      route: "settings",
      route_params: { vendor_id: "vendor-1" },
    });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("does nothing visible when criteria are not met (RPC returns false)", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });

    const promoted = await checkAndNotifyAdminGreenReady("vendor-1", {
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(false);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("checkAndNotifyAdminCategoryGreenReady — per-business variant", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    notifyAdminMock.mockReset();
    toastErrorMock.mockReset();
    getUserPhoneMock.mockReset();
    getUserPhoneMock.mockReturnValue("9900011111");
  });

  it("surfaces a visible error toast when the category promote RPC fails", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "cat-boom" } });

    const promoted = await checkAndNotifyAdminCategoryGreenReady("vendor-1", "cat-1", {
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      strings.en.vendor_green_promote_failed,
      expect.objectContaining({ description: "cat-boom" }),
    );
    expect(notifyAdminMock).not.toHaveBeenCalled();
  });

  it("notifies the admin when a business genuinely reaches green_pending", async () => {
    rpcMock.mockResolvedValue({ data: true, error: null });

    const promoted = await checkAndNotifyAdminCategoryGreenReady("vendor-1", "cat-1", {
      shopName: "Atul Milk",
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(true);
    expect(rpcMock).toHaveBeenCalledWith("vendor_promote_category_green_pending", {
      p_vendor_id: "vendor-1",
      p_vendor_phone: "9900011111",
      p_category_id: "cat-1",
    });
    expect(notifyAdminMock).toHaveBeenCalledTimes(1);
    const [title, body] = notifyAdminMock.mock.calls[0] as [string, string];
    expect(title).toBe(strings.en.admin_green_ready_title);
    expect(body).toContain("Atul Milk");
  });

  it("stays silent when the category was already green_pending (RPC returns false)", async () => {
    rpcMock.mockResolvedValue({ data: false, error: null });

    const promoted = await checkAndNotifyAdminCategoryGreenReady("vendor-1", "cat-1", {
      vendorPhone: "9900011111",
    });

    expect(promoted).toBe(false);
    expect(notifyAdminMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
