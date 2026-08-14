import { describe, expect, it } from "vitest";
import { isMyOrdersOverlayBlockingAutoRating } from "@/lib/myOrdersAutoRating";

describe("isMyOrdersOverlayBlockingAutoRating", () => {
  it("returns false when no overlay is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({})).toBe(false);
  });

  it("blocks when payment sheet is loading", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ paymentSheetLoading: true })).toBe(true);
  });

  it("blocks when payment sheet is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ paymentSheetOpen: true })).toBe(true);
  });

  it("blocks when khata detail sheet is open", () => {
    expect(isMyOrdersOverlayBlockingAutoRating({ khataDetailOpen: true })).toBe(true);
  });

  it("blocks when any listed overlay is open", () => {
    expect(
      isMyOrdersOverlayBlockingAutoRating({
        editOrderOpen: true,
        billHistoryOpen: false,
      }),
    ).toBe(true);
  });
});
