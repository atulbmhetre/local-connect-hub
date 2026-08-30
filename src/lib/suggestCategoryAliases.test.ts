import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("suggest-category-aliases Phase 4 prompt", () => {
  const src = readFileSync(
    join(process.cwd(), "supabase/functions/suggest-category-aliases/index.ts"),
    "utf8",
  );

  it("requires whole-profile anti keyword-trap reasoning", () => {
    expect(src).toContain("anti keyword-trap");
    expect(src).toContain("NEVER propose an alias because ONE word appears in isolation");
    expect(src).toContain('"milk" on a restaurant menu');
    expect(src).toContain('"kirana" fits Grocery Store');
  });

  it("records proactive_ai evidence instead of inserting pending_review directly", () => {
    expect(src).toContain('p_source: "proactive_ai"');
    expect(src).toContain("record_search_alias_evidence");
    expect(src).not.toContain('status: "pending_review"');
  });

  it("stores confidence and ai_reasoning per alias", () => {
    expect(src).toContain("confidence: alias.confidence");
    expect(src).toContain("ai_reasoning: alias.reasoning");
    expect(src).toContain("suggested_by_vendor_id: vendorId");
  });
});
