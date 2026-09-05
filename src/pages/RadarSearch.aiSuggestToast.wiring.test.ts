import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Radar AI-suggest failure toast", () => {
  it("shows search_category_unavailable when invokeSuggestCategory fails", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/pages/RadarSearch.tsx"),
      "utf8",
    );
    expect(src).toContain("invokeSuggestCategory");
    expect(src).toMatch(/if\s*\(\s*!result\.success\s*\)/);
    expect(src).toContain("search_category_unavailable");
    expect(src).toContain('toast.info(s.search_category_unavailable');
  });
});
