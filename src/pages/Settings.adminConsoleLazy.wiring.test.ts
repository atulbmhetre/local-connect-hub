import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Settings AdminConsole lazy chunk", () => {
  const src = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");

  it("lazy-loads AdminConsole instead of a static import", () => {
    expect(src).not.toMatch(
      /import\s*\{\s*AdminConsole\s*\}\s*from\s*"@\/components\/settings\/AdminConsole"/,
    );
    expect(src).toContain('import("@/components/settings/AdminConsole")');
    expect(src).toContain("<Suspense");
  });
});
