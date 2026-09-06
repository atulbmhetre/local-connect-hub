import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("AdminConsole action failure captureError wiring", () => {
  const src = readFileSync(resolve(__dirname, "AdminConsole.tsx"), "utf8");

  it("imports captureError and actually calls it on admin action failures", () => {
    expect(src).toMatch(/import\s*\{\s*captureError,\s*phoneSuffix\s*\}\s*from\s*"@\/lib\/sentry"/);
    expect(src.match(/captureError\(/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it("covers ban, category, license review, and config update failure paths", () => {
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.updateConfig",\s*key\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.banVendor",\s*vendorId:\s*v\.id\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.unbanVendor",\s*vendorId\s*\}\s*\)/,
    );
    expect(src).toMatch(/scope:\s*"adminConsole\.banUser"/);
    expect(src).toMatch(/scope:\s*"adminConsole\.unbanUser"/);
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.approveCategory",\s*categoryId:\s*cat\.id\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /captureError\(\s*updateError,\s*\{\s*scope:\s*"adminConsole\.rejectCategory",\s*categoryId:\s*cat\.id\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.approveLicense",\s*categoryId:\s*row\.id\s*\}\s*\)/,
    );
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"adminConsole\.rejectLicense",\s*categoryId:\s*row\.id\s*\}\s*\)/,
    );
  });

  it("redacts full phone on user ban/unban extras", () => {
    expect(src).toMatch(
      /scope:\s*"adminConsole\.banUser",\s*phoneSuffix:\s*phoneSuffix\(bannedPhone\)/,
    );
    expect(src).toMatch(
      /scope:\s*"adminConsole\.unbanUser",\s*phoneSuffix:\s*phoneSuffix\(phone\)/,
    );
    expect(src).not.toMatch(/scope:\s*"adminConsole\.banUser",\s*phone\s*:/);
    expect(src).not.toMatch(/scope:\s*"adminConsole\.unbanUser",\s*phone\s*:/);
  });
});
