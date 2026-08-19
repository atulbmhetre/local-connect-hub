import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gallery vs camera-only capture points", () => {
  it("does not force capture=environment on parse-image file pickers", () => {
    const files = [
      "src/components/ParchiSheet.tsx",
      "src/pages/MyOrders.tsx",
      "src/components/BillSheet.tsx",
      "src/components/settings/VendorMyBusinessOperations.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(rel), "utf8");
      expect(src, rel).not.toMatch(/capture\s*=\s*["']environment["']/);
    }
  });

  it("keeps shop/selfie LiveCamera on CameraSource.Camera (no Prompt)", () => {
    const files = [
      "src/components/vendor/VendorRegistrationWizard.tsx",
      "src/components/settings/VendorMyBusiness.tsx",
      "src/components/vendor/BusinessSetupSheet.tsx",
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(rel), "utf8");
      expect(src, rel).not.toMatch(/source=\{CameraSource\.Prompt\}/);
    }
  });

  it("lets menu item photos use gallery (Prompt + file input)", () => {
    const src = readFileSync(resolve("src/components/settings/VendorMyBusinessOperations.tsx"), "utf8");
    expect(src).toMatch(/source=\{CameraSource\.Prompt\}/);
    expect(src).toMatch(/data-testid="menu-photo-file-new"/);
    expect(src).toMatch(/data-testid="menu-photo-file-edit"/);
  });
});
