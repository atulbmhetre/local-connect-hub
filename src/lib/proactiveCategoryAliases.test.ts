import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDeviceId: vi.fn(() => "unit-device"),
}));

vi.mock("@/lib/deviceId", () => ({ getDeviceId: mocks.getDeviceId }));
vi.mock("@/lib/supabase", () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

import {
  triggerProactiveCategoryAliases,
  triggerProactiveCategoryAliasesForCategories,
} from "./proactiveCategoryAliases";

describe("proactiveCategoryAliases", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  it("fire-and-forgets suggest-category-aliases invoke", async () => {
    triggerProactiveCategoryAliases({
      vendorId: "v1",
      categoryId: "c1",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.invoke).toHaveBeenCalledWith("suggest-category-aliases", {
      body: {
        vendor_id: "v1",
        category_id: "c1",
        device_id: "unit-device",
      },
    });
  });

  it("dedupes duplicate category ids in batch trigger", async () => {
    triggerProactiveCategoryAliasesForCategories("v1", ["c1", "c1"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("suggest-category-aliases", {
      body: expect.objectContaining({ category_id: "c1", vendor_id: "v1" }),
    });
  });

  it("skips blank ids", async () => {
    triggerProactiveCategoryAliases({ vendorId: "", categoryId: "c1" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
