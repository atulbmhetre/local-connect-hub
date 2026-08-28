import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc: mocks.rpc },
}));

import { logUnresolvedSearchTerm } from "./unresolvedSearchTerms";

describe("logUnresolvedSearchTerm", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
    mocks.rpc.mockResolvedValue({ data: null, error: null });
  });

  it("rpc-logs term + original when present", async () => {
    await logUnresolvedSearchTerm({
      term: "still lost",
      originalTermIfRephrased: "body care",
    });
    expect(mocks.rpc).toHaveBeenCalledWith("log_unresolved_search_term", {
      p_term: "still lost",
      p_original_term_if_rephrased: "body care",
    });
  });

  it("skips blank terms", async () => {
    await logUnresolvedSearchTerm({ term: "   " });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
