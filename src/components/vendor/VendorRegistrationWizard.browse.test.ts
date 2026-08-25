import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("VendorRegistrationWizard browse-all-categories (Defect #20)", () => {
  const src = readFileSync(resolve(__dirname, "VendorRegistrationWizard.tsx"), "utf8");

  it("hides the permanent Browse all categories link once a category is selected or pending", () => {
    expect(src).toContain('data-testid="reg-browse-all-categories"');
    expect(src).toMatch(
      /selectedCategoryIds\.length === 0 && !pendingNewCategoryCreate[\s\S]{0,280}reg-browse-all-categories/,
    );
  });

  it("keeps Browse all categories inside the no-match card", () => {
    expect(src).toContain("category_noMatchFound");
    expect(src).toContain('data-testid="reg-browse-all-categories-nomatch"');
    const noMatchIdx = src.indexOf("category_noMatchFound");
    const noMatchBrowse = src.indexOf("reg-browse-all-categories-nomatch");
    expect(noMatchBrowse).toBeGreaterThan(noMatchIdx);
  });
});

describe("VendorRegistrationWizard Phase 2 step boundaries", () => {
  const src = readFileSync(resolve(__dirname, "VendorRegistrationWizard.tsx"), "utf8");
  const step1 = src.slice(src.indexOf("{regPage === 1 &&"), src.indexOf("{regPage === 2 &&"));
  const step2 = src.slice(src.indexOf("{regPage === 2 &&"));

  it("keeps Step 1 to name, phone, selfie (not UPI / base_type / GPS)", () => {
    expect(step1).toContain("vendor_your_name");
    expect(step1).toContain("vendor_phone_label");
    expect(step1).toContain("reg-selfie-capture");
    expect(step1).not.toContain("vendor_upi_label");
    expect(step1).not.toContain("reg_where_work_from");
    expect(step1).not.toContain("vendor_capture_location");
    expect(src).toContain("const stepAReady = nameOk && phoneOk && selfieCaptured;");
  });

  it("puts GPS capture on Step 2 before shop photo so match is not the distance-0 no-op", () => {
    expect(step2).toContain("reg_where_work_from");
    expect(step2).toContain("vendor_upi_label");
    expect(step2).toContain("detectLocation");
    const gpsIdx = step2.indexOf("vendor_capture_location");
    const photoIdx = step2.indexOf("reg-shop-photo-capture");
    expect(gpsIdx).toBeGreaterThan(-1);
    expect(photoIdx).toBeGreaterThan(gpsIdx);
    expect(src).toMatch(/handleShopPhotoCapture[\s\S]*?if \(coords\) \{[\s\S]*?evaluateGpsMatch\(coords, shot\.coords\)/);
    expect(src).toMatch(
      /reg-shop-photo-capture[\s\S]*?if \(!gpsOk\) \{[\s\S]*?reg_toast_missing_gps/,
    );
    expect(src).toContain("baseType !== \"\" &&");
    expect(src).toContain("upiFmtOk &&");
    expect(src).toContain("gpsOk &&");
  });
});
