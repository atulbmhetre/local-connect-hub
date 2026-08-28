import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("suggest-category Phase 3 pending review", () => {
  const src = readFileSync(
    resolve(__dirname, "../../supabase/functions/suggest-category/index.ts"),
    "utf8",
  );

  it("never auto-approves on suggestion_count >= 2", () => {
    expect(src).not.toMatch(/nextCount\s*>=\s*2/);
    expect(src).not.toContain("new_auto_approved");
    expect(src).not.toContain("autoApprove");
    expect(src).toContain("never auto-approve");
  });

  it("asks AI for mode reasoning, aliases, and overlap fields", () => {
    expect(src).toContain("service_mode_reasoning");
    expect(src).toContain("proposed_aliases");
    expect(src).toContain("overlap_category_label");
    expect(src).toContain("overlap_reasoning");
    expect(src).toContain("urgent-vs-scheduled");
  });
});
