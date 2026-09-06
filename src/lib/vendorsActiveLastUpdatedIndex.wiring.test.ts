import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vendors_active_last_updated_idx migration", () => {
  const mig = readFileSync(
    resolve(
      "supabase/migrations/20260906140001_vendors_active_last_updated_idx.sql",
    ),
    "utf8",
  );

  it("creates a partial index on active vendors for last_updated filters", () => {
    expect(mig).toContain("vendors_active_last_updated_idx");
    expect(mig).toContain("(is_active, last_updated)");
    expect(mig).toContain("WHERE is_active = true");
  });
});
