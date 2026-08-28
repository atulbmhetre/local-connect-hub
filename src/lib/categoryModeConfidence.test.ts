import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ data: null, error: null })),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mocks.rpc },
}));

import { triggerCategoryModeConfidenceCheck } from "./categoryModeConfidence";

describe("triggerCategoryModeConfidenceCheck", () => {
  beforeEach(() => {
    mocks.rpc.mockClear();
  });

  it("fire-and-forgets maybe_flag_category_mode_reviews with deduped ids", async () => {
    triggerCategoryModeConfidenceCheck(["c1", "c1", " c2 ", ""]);
    await vi.waitFor(() => {
      expect(mocks.rpc).toHaveBeenCalledWith("maybe_flag_category_mode_reviews", {
        p_category_ids: ["c1", "c2"],
      });
    });
  });

  it("no-ops on empty input", async () => {
    triggerCategoryModeConfidenceCheck([]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
