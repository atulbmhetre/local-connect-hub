import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  loadAdminSupportMessages,
  lookupAdminCustomer,
  resolveAdminSupportMessage,
} from "@/lib/adminSupportOps";

const { captureError, rpcMock } = vi.hoisted(() => ({
  captureError: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

describe("adminSupportOps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadAdminSupportMessages maps RPC rows and ignores empty ids", async () => {
    rpcMock.mockResolvedValue({
      data: [
        {
          id: "msg-1",
          kind: "contact",
          category: "order",
          rating: null,
          message: "Bill never arrived",
          user_phone: "9876543210",
          vendor_id: null,
          vendor_shop_name: null,
          device_id: "dev-1",
          email_sent: true,
          created_at: "2026-09-06T00:00:00Z",
          resolved_at: null,
        },
        { id: "", kind: "feedback", message: "skip" },
      ],
      error: null,
    });

    const result = await loadAdminSupportMessages(false);
    expect(rpcMock).toHaveBeenCalledWith("admin_list_support_messages", {
      p_include_resolved: false,
    });
    expect(result.ok).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: "msg-1",
      kind: "contact",
      category: "order",
      user_phone: "9876543210",
      email_sent: true,
      resolved_at: null,
    });
  });

  it("loadAdminSupportMessages: RPC failure → captureError and empty list", async () => {
    const err = { message: "forced_support_list_fail" };
    rpcMock.mockResolvedValue({ data: null, error: err });

    const result = await loadAdminSupportMessages(true);
    expect(result).toEqual({ ok: false, rows: [] });
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ scope: "adminSupport.list", includeResolved: true }),
    );
  });

  it("resolveAdminSupportMessage: RPC failure → captureError", async () => {
    const err = { message: "forced_resolve_fail" };
    rpcMock.mockResolvedValue({ data: null, error: err });

    const result = await resolveAdminSupportMessage("msg-1");
    expect(result).toEqual({ ok: false, error: "forced_resolve_fail" });
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ scope: "adminSupport.resolve", messageId: "msg-1" }),
    );
  });

  it("lookupAdminCustomer rejects invalid phone without RPC", async () => {
    const result = await lookupAdminCustomer("123");
    expect(result).toEqual({ ok: false, error: "invalid_phone_format" });
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("lookupAdminCustomer maps payload and redacts phone on captureError", async () => {
    rpcMock.mockResolvedValue({
      data: {
        found: true,
        phone: "9876543210",
        user: {
          phone: "9876543210",
          trust_score: 80,
          is_banned: false,
          ban_reason: null,
          deletion_requested_at: null,
          warn_count: 0,
          noshow_count: 1,
          fake_count: 0,
        },
        vendor: null,
        orders: [
          {
            id: "req-1",
            status: "accepted",
            payment_status: "disputed",
            service_mode: "help",
            created_at: "2026-09-06T00:00:00Z",
            vendor_id: "v1",
            vendor_shop_name: "Shop",
          },
        ],
        disputes: [],
        khata: [],
      },
      error: null,
    });

    const result = await lookupAdminCustomer("9876543210");
    expect(rpcMock).toHaveBeenCalledWith("admin_lookup_customer", {
      p_phone: "9876543210",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.found).toBe(true);
      expect(result.data.orders).toHaveLength(1);
      expect(result.data.user?.noshow_count).toBe(1);
    }

    const err = { message: "forced_lookup_fail" };
    rpcMock.mockResolvedValue({ data: null, error: err });
    const failed = await lookupAdminCustomer("+91 98765 43210");
    expect(failed.ok).toBe(false);
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        scope: "adminSupport.lookupCustomer",
        phoneSuffix: "3210",
      }),
    );
  });
});
