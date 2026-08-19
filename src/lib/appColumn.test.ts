import { describe, expect, it } from "vitest";
import { APP_COLUMN_CLASS, APP_COLUMN_WIDTH_CLASS } from "@/lib/appColumn";

describe("app column contract", () => {
  it("matches AppShell's existing max-w-md column", () => {
    expect(APP_COLUMN_WIDTH_CLASS).toBe("max-w-md");
    expect(APP_COLUMN_CLASS).toContain("mx-auto");
    expect(APP_COLUMN_CLASS).toContain("max-w-md");
  });
});
