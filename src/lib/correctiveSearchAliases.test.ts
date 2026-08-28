import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  getDeviceId: vi.fn(() => "unit-device"),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: mocks.getDeviceId }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    rpc: mocks.rpc,
  },
}));

import {
  logUnresolvedSearchTermReturningId,
  triggerCorrectiveAliasProposal,
} from "./correctiveSearchAliases";

describe("correctiveSearchAliases", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.rpc.mockReset();
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
    mocks.rpc.mockResolvedValue({ data: "uid-1", error: null });
  });

  it("fire-and-forgets propose-corrective-alias", async () => {
    triggerCorrectiveAliasProposal({
      term: "buffalo milk delivery zzqx",
      originalTermIfRephrased: "need milk",
      bestGuessCategoryId: "cat-dairy",
      unresolvedId: "uid-1",
      confidence: 0.9,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.invoke).toHaveBeenCalledWith("propose-corrective-alias", {
      body: {
        term: "buffalo milk delivery zzqx",
        original_term_if_rephrased: "need milk",
        best_guess_category_id: "cat-dairy",
        unresolved_id: "uid-1",
        confidence: 0.9,
        device_id: "unit-device",
      },
    });
  });

  it("skips blank term or category", async () => {
    triggerCorrectiveAliasProposal({
      term: "  ",
      bestGuessCategoryId: "cat-dairy",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("returns unresolved row id from rpc", async () => {
    const id = await logUnresolvedSearchTermReturningId({
      term: "still lost",
      originalTermIfRephrased: "body care",
    });
    expect(id).toBe("uid-1");
    expect(mocks.rpc).toHaveBeenCalledWith("log_unresolved_search_term", {
      p_term: "still lost",
      p_original_term_if_rephrased: "body care",
    });
  });
});
