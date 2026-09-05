import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchParseImageJson } from "@/lib/parseImageFetch";

const { mockFetch, showNetworkRetryingToast } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  showNetworkRetryingToast: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  SUPABASE_URL: "http://test",
  SUPABASE_ANON_KEY: "anon",
}));

vi.mock("@/hooks/useNetworkStatus", () => ({
  getNavigatorOnline: () => true,
}));

vi.mock("@/lib/networkToast", () => ({
  showNetworkRetryingToast,
  dismissNetworkRetryingToast: vi.fn(),
  showNetworkFailedToast: vi.fn(),
}));

describe("fetchParseImageJson (M10)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    showNetworkRetryingToast.mockReset();
    vi.stubGlobal("fetch", mockFetch);
  });

  it("retries a hung/failed parse-image request then succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, text: "milk 1L" }),
      });

    const data = await fetchParseImageJson("parse-image-order", {
      image_base64: "abc",
      media_type: "image/jpeg",
    });

    expect(data).toEqual({ success: true, text: "milk 1L" });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(showNetworkRetryingToast).toHaveBeenCalled();
  });
});
