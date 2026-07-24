import { describe, expect, it, vi, beforeEach } from "vitest";
import { loadAdminLowRatings, deleteAdminLowRating } from "@/lib/adminLowRatings";

const { captureError, fromMock, rpcMock } = vi.hoisted(() => ({
  captureError: vi.fn(),
  fromMock: vi.fn(),
  rpcMock: vi.fn(),
}));

vi.mock("@/lib/sentry", () => ({ captureError }));

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

describe("admin low ratings captureError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loadAdminLowRatings: forces fetch failure → captureError settings.loadLowRatings", async () => {
    const err = { message: "forced_low_ratings_load_fail" };
    fromMock.mockReturnValue({
      select: () => ({
        lte: () => ({
          order: () => ({
            limit: async () => ({ data: null, error: err }),
          }),
        }),
      }),
    });

    const rows = await loadAdminLowRatings("Vendor");
    expect(rows).toEqual([]);
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ scope: "settings.loadLowRatings" }),
    );
  });

  it("deleteAdminLowRating: forces RPC failure → captureError settings.deleteLowRating", async () => {
    const err = { message: "forced_delete_review_fail" };
    rpcMock.mockResolvedValue({ data: null, error: err });

    const result = await deleteAdminLowRating(
      { id: "rev-1", vendor_id: "vend-1" },
      "9999999999",
    );
    expect(result).toEqual({ ok: false, error: err });
    expect(captureError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        scope: "settings.deleteLowRating",
        reviewId: "rev-1",
        vendorId: "vend-1",
      }),
    );
  });

  it("loadAdminLowRatings: empty shop_name uses localized vendor fallback", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        lte: () => ({
          order: () => ({
            limit: async () => ({
              data: [
                {
                  id: "rev-2",
                  vendor_id: "vend-2",
                  rating: 1,
                  review_text: null,
                  user_phone: "98",
                  created_at: "2026-01-01T00:00:00Z",
                  vendors: { shop_name: "  " },
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    });

    const rows = await loadAdminLowRatings("विक्रेता");
    expect(rows[0]?.shop_name).toBe("विक्रेता");
    expect(captureError).not.toHaveBeenCalled();
  });
});
