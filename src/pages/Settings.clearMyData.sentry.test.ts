import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Settings clearMyData Sentry redaction", () => {
  it("captures clear_my_data failures with phoneSuffix, not full phone", () => {
    const src = readFileSync(resolve(__dirname, "Settings.tsx"), "utf8");
    expect(src).toMatch(/import\s*\{\s*captureError,\s*phoneSuffix\s*\}\s*from\s*"@\/lib\/sentry"/);
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"settings\.clearMyData",\s*phoneSuffix:\s*phoneSuffix\(phone\)\s*\}\s*\)/,
    );
    expect(src).not.toMatch(/scope:\s*"settings\.clearMyData",\s*phone\s*\}/);
  });
});
