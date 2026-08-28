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

  it("shows vendors-only posts to a vendor reader and keeps customer-facing posts visible", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    });
    const posts = [
      { id: "v-only", target_audience: "vendors" as const, target_category_id: null },
      { id: "cust", target_audience: "customers" as const, target_category_id: null },
    ];
    const result = await filterPostsByAudienceAndCategory(posts, "vendor-1");
    expect(result.map((p) => p.id)).toEqual(["v-only", "cust"]);
  });

  it("shows customers-audience posts to a vendor reader even when membership lookup fails", async () => {
    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => Promise.resolve({ data: null, error: { message: "fail" } }),
        }),
      }),
    });
    const posts = [
      { id: "cust", target_audience: "customers" as const, target_category_id: null },
      { id: "v-all", target_audience: "vendors" as const, target_category_id: null },
      {
        id: "v-cat",
        target_audience: "vendors" as const,
        target_category_id: "cat-x",
      },
    ];
    const result = await filterPostsByAudienceAndCategory(posts, "vendor-1");
    expect(result.map((p) => p.id)).toEqual(["cust", "v-all"]);
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

  it("shows a Pharmacy-targeted offer to a Pharmacy vendor, not to a Grocery vendor", async () => {
    const posts = [
      {
        id: "pharmacy-offer",
        target_audience: "vendors" as const,
        target_category_id: "cat-pharmacy",
      },
    ];

    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ category_id: "cat-pharmacy" }],
              error: null,
            }),
        }),
      }),
    });
    const pharmacySees = await filterPostsByAudienceAndCategory(posts, "pharmacy-vendor");
    expect(pharmacySees.map((p) => p.id)).toEqual(["pharmacy-offer"]);

    fromMock.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () =>
            Promise.resolve({
              data: [{ category_id: "cat-grocery" }],
              error: null,
            }),
        }),
      }),
    });
    const grocerySees = await filterPostsByAudienceAndCategory(posts, "grocery-vendor");
    expect(grocerySees.map((p) => p.id)).toEqual([]);
  });
});
