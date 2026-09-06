import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("FirstOpenFlow restore debug logging", () => {
  it("gates console.log behind RESTORE_DEBUG before any logging", () => {
    const src = readFileSync(resolve("src/components/FirstOpenFlow.tsx"), "utf8");
    expect(src).toContain("const RESTORE_DEBUG = import.meta.env.DEV;");
    expect(src).toMatch(
      /pushRestoreDebug[\s\S]*?if \(!RESTORE_DEBUG\) return;[\s\S]*?console\.log\(`\[restore-debug/,
    );
  });
});
