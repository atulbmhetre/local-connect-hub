import { describe, expect, it, vi, beforeEach } from "vitest";

const fromMock = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { filterPostsByAudienceAndCategory } from "./feedAudienceFilter";

describe("filterPostsByAudienceAndCategory", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("hides vendors-only posts from customers", async () => {
    const posts = [
      { id: "1", target_audience: "vendors" as const, target_category_id: null },
      { id: "2", target_audience: "customers" as const, target_category_id: null },
      { id: "3", target_audience: "both" as const, target_category_id: null },
    ];
    const result = await filterPostsByAudienceAndCategory(posts, null);
    expect(result.map((p) => p.id)).toEqual(["2", "3"]);
  });

  it("hides category-scoped vendor posts from vendors without that category", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ category_id: "cat-plumber" }],
              error: null,
            }),
        }),
      }),
    });

    const posts = [
      {
        id: "grocery",
        target_audience: "vendors" as const,
        target_category_id: "cat-grocery",
      },
      {
        id: "plumber",
        target_audience: "vendors" as const,
        target_category_id: "cat-plumber",
      },
      {
        id: "all-vendors",
        target_audience: "vendors" as const,
        target_category_id: null,
      },
    ];
    const result = await filterPostsByAudienceAndCategory(posts, "vendor-1");
    expect(result.map((p) => p.id)).toEqual(["plumber", "all-vendors"]);
  });
});
