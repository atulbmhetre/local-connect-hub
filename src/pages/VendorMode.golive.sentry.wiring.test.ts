import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("VendorMode go-live captureError wiring", () => {
  it("captures unknown patchVendorOwn failures, not known go-live tokens", () => {
    const src = readFileSync(resolve(__dirname, "VendorMode.tsx"), "utf8");
    expect(src).toMatch(/import\s*\{\s*captureError,\s*toCapturedError\s*\}\s*from\s*"@\/lib\/sentry"/);
    expect(src).toMatch(
      /captureError\(\s*error,\s*\{\s*scope:\s*"vendorMode\.applyActiveState",\s*vendorId:\s*vendor\.id,\s*goingLive:\s*next,?\s*\}\s*\)/,
    );
    const photosIdx = src.indexOf('msg.includes("vendor_photos_required")');
    const bannedIdx = src.indexOf('msg.includes("vendor_banned")');
    const captureIdx = src.indexOf('scope: "vendorMode.applyActiveState"');
    expect(photosIdx).toBeGreaterThan(0);
    expect(bannedIdx).toBeGreaterThan(photosIdx);
    expect(captureIdx).toBeGreaterThan(bannedIdx);
  });
});
