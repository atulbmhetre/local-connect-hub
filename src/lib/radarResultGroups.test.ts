import { describe, expect, it } from "vitest";
import { groupRadarResultsByCategory } from "@/lib/radarResultGroups";

function item(
  categoryId: string,
  label: string,
  dist: number | null,
  emoji = "✨",
) {
  return {
    dist,
    vendor: { categories: [{ category_id: categoryId, label, emoji }] },
  };
}

describe("groupRadarResultsByCategory", () => {
  it("does not group a single-category result list", () => {
    const results = [item("d1", "Dairy", 1), item("d1", "Dairy", 3)];
    const g = groupRadarResultsByCategory(results);
    expect(g.shouldGroup).toBe(false);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0].items).toHaveLength(2);
  });

  it("groups multi-category results with nearest-group first", () => {
    const results = [
      item("g1", "Grocery Store", 5, "🛒"),
      item("d1", "Dairy", 2, "🥛"),
      item("g1", "Grocery Store", 8, "🛒"),
    ];
    const g = groupRadarResultsByCategory(results);
    expect(g.shouldGroup).toBe(true);
    expect(g.groups.map((x) => x.label)).toEqual(["Dairy", "Grocery Store"]);
    expect(g.groups[0].items.map((i) => i.dist)).toEqual([2]);
    expect(g.groups[1].items.map((i) => i.dist)).toEqual([5, 8]);
  });

  it("keeps empty input as no groups", () => {
    const g = groupRadarResultsByCategory([]);
    expect(g.shouldGroup).toBe(false);
    expect(g.groups).toEqual([]);
  });
});
