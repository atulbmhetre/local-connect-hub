import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TrustLevel } from "@/lib/trustLevel";
import {
  bestMatchingMenuItem,
  compareRadarResultsWithMenuMatch,
  foldRadarSearchText,
  isSearchMoreSpecificThanCategoryLabels,
  menuItemNameMatchesTerm,
  promoteMatchedMenuPreview,
  shouldApplyRadarMenuRanking,
} from "@/lib/radarMenuMatch";

describe("radarMenuMatch", () => {
  it("treats CCTV installation as more specific than Electrician", () => {
    expect(
      isSearchMoreSpecificThanCategoryLabels("CCTV installation", ["Electrician"]),
    ).toBe(true);
    expect(isSearchMoreSpecificThanCategoryLabels("Electrician", ["Electrician"])).toBe(
      false,
    );
    expect(isSearchMoreSpecificThanCategoryLabels("electrician", ["Electrician"])).toBe(
      false,
    );
  });

  it("matches menu names by exact, substring, tokens, and trigram", () => {
    expect(menuItemNameMatchesTerm("CCTV installation", "CCTV installation")).toBe(true);
    expect(menuItemNameMatchesTerm("CCTV camera installation", "CCTV installation")).toBe(
      true,
    );
    expect(menuItemNameMatchesTerm("Fan repair", "CCTV installation")).toBe(false);
    expect(menuItemNameMatchesTerm("Tomato 1kg", "CCTV installation")).toBe(false);
    expect(foldRadarSearchText("  CCTV   installation ")).toBe("cctv installation");
  });

  it("applies only on help and appointment, never delivery", () => {
    const labels = ["Electrician"];
    expect(
      shouldApplyRadarMenuRanking({
        radarMode: "help",
        searchTerm: "CCTV installation",
        categoryLabels: labels,
      }),
    ).toBe(true);
    expect(
      shouldApplyRadarMenuRanking({
        radarMode: "appointment",
        searchTerm: "CCTV installation",
        categoryLabels: labels,
      }),
    ).toBe(true);
    expect(
      shouldApplyRadarMenuRanking({
        radarMode: "delivery",
        searchTerm: "Tomato 1kg",
        categoryLabels: ["Grocery Store"],
      }),
    ).toBe(false);
    expect(
      shouldApplyRadarMenuRanking({
        radarMode: "help",
        searchTerm: "Electrician",
        categoryLabels: labels,
      }),
    ).toBe(false);
  });

  it("ranks a menu match above a closer non-match and never drops empty menus", () => {
    const hit = { menuMatch: true, dist: 1.2, trustLevel: "Unverified" as TrustLevel };
    const closerEmpty = { menuMatch: false, dist: 0.1, trustLevel: "Gold" as TrustLevel };
    expect(compareRadarResultsWithMenuMatch(hit, closerEmpty)).toBeLessThan(0);

    const items = [
      { name: "Fan repair", price: 200, unit: null },
      { name: "CCTV installation", price: 1500, unit: "job" },
    ];
    expect(bestMatchingMenuItem(items, "CCTV installation")?.name).toBe(
      "CCTV installation",
    );
    expect(bestMatchingMenuItem([], "CCTV installation")).toBeNull();
    expect(
      promoteMatchedMenuPreview(items, "CCTV installation", 3).map((i) => i.name),
    ).toEqual(["CCTV installation", "Fan repair"]);
  });

  it("RadarSearch ranks from already-fetched menus and does not write category_search_terms", () => {
    const radar = readFileSync(resolve("src/pages/RadarSearch.tsx"), "utf8");
    expect(radar).toContain("shouldApplyRadarMenuRanking");
    expect(radar).toContain("compareRadarResultsWithMenuMatch");
    expect(radar).toContain("promoteMatchedMenuPreview");
    expect(radar).not.toMatch(/from\(["']category_search_terms["']\)/);
    expect(radar).not.toContain("suggest-category-aliases");
    expect(radar).not.toContain("record_search_alias_evidence");
  });
});
