import { describe, expect, it } from "vitest";
import {
  buildCategoryOrderStats,
  filterMenuItemsByCategoryContext,
  groupMenuItemsByCategory,
  resolveCancelReasonsForCategory,
} from "./categoryScopedVendor";

describe("filterMenuItemsByCategoryContext", () => {
  const items = [
    { name: "A", price: 1, category_id: "cat-1" },
    { name: "B", price: 2, category_id: "cat-2" },
    { name: "C", price: 3, category_id: null },
  ];

  it("returns all items when no matched category", () => {
    expect(filterMenuItemsByCategoryContext(items, null)).toHaveLength(3);
  });

  it("filters to matched category only", () => {
    expect(filterMenuItemsByCategoryContext(items, "cat-1").map((i) => i.name)).toEqual([
      "A",
    ]);
  });
});

describe("groupMenuItemsByCategory", () => {
  it("groups under category headers", () => {
    const labels = new Map([["cat-1", "Plumber"], ["cat-2", "Electrician"]]);
    const groups = groupMenuItemsByCategory(
      [
        { name: "A", price: 1, category_id: "cat-2" },
        { name: "B", price: 2, category_id: "cat-1" },
      ],
      labels,
    );
    expect(groups.map((g) => g.label)).toEqual(["Electrician", "Plumber"]);
  });
});

describe("resolveCancelReasonsForCategory", () => {
  const account = ["Too busy", "Out of stock", null, ""];

  it("uses category reasons when present", () => {
    const map = new Map([["cat-1", ["Wiring only", "No parts"]]]);
    expect(resolveCancelReasonsForCategory("cat-1", map, account)).toEqual([
      "Wiring only",
      "No parts",
    ]);
  });

  it("falls back to account-level when category has no reasons", () => {
    const map = new Map<string, string[]>();
    expect(resolveCancelReasonsForCategory("cat-1", map, account)).toEqual([
      "Too busy",
      "Out of stock",
    ]);
  });

  it("falls back when category reasons are all blank", () => {
    const map = new Map([["cat-1", ["", "  "]]]);
    expect(resolveCancelReasonsForCategory("cat-1", map, account)).toEqual([
      "Too busy",
      "Out of stock",
    ]);
  });
});

describe("buildCategoryOrderStats", () => {
  it("breaks down counts per category_id", () => {
    const labels = new Map([["cat-1", "Plumber"], ["cat-2", "Electrician"]]);
    const stats = buildCategoryOrderStats(
      [
        { status: "fulfilled", category_id: "cat-1" },
        { status: "cancelled", category_id: "cat-1" },
        { status: "sent", category_id: "cat-2" },
      ],
      labels,
    );
    expect(stats.find((s) => s.categoryId === "cat-1")?.total).toBe(2);
    expect(stats.find((s) => s.categoryId === "cat-1")?.fulfilled).toBe(1);
    expect(stats.find((s) => s.categoryId === "cat-2")?.total).toBe(1);
  });
});
