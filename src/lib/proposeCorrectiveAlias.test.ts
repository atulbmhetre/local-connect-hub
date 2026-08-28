import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("propose-corrective-alias Phase 5", () => {
  const src = readFileSync(
    join(process.cwd(), "supabase/functions/propose-corrective-alias/index.ts"),
    "utf8",
  );

  it("inserts corrective_ai pending_review only", () => {
    expect(src).toContain('source: "corrective_ai"');
    expect(src).toContain('status: "pending_review"');
  });

  it("requires a best-guess category (gateway strips low-confidence candidates)", () => {
    expect(src).toContain("no_usable_guess");
    expect(src).toContain("missing_best_guess");
    expect(src).toContain("Gateway strips candidates on no_confident_match");
  });

  it("marks unresolved_search_terms.resolved_category_id after propose", () => {
    expect(src).toContain("mark_unresolved_search_term_resolved");
    expect(src).toContain("p_resolved_category_id");
  });
});
