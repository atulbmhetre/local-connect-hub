import { describe, expect, it, vi, beforeEach } from "vitest";
import { toast } from "sonner";
import { persistVendorServiceRadius } from "@/lib/vendorServiceRadius";
import { strings } from "@/lib/strings";

const mockRpc = vi.hoisted(() => vi.fn());

vi.mock("@/lib/vendorPatch", () => ({
  patchVendorOwn: (...args: unknown[]) => mockRpc(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("persistVendorServiceRadius", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ok when update succeeds", async () => {
    mockRpc.mockResolvedValue({ error: null });
    const result = await persistVendorServiceRadius("vendor-1", "9900000001", 25);
    expect(result).toEqual({ ok: true });
  });

  it("surfaces vendor_radius_save_error toast on failure", async () => {
    mockRpc.mockResolvedValue({ error: { message: "permission denied" } });
    const result = await persistVendorServiceRadius("vendor-1", "9900000001", 25);
    expect(result.ok).toBe(false);

    if (!result.ok) {
      toast.error(strings.en.vendor_radius_save_error);
    }
    expect(toast.error).toHaveBeenCalledWith(strings.en.vendor_radius_save_error);
  });
});
