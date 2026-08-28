import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("category mode confidence wiring (impact scope)", () => {
  it("registration and mode-edit call fire-and-forget check", () => {
    const wizard = readFileSync(
      resolve("src/components/vendor/VendorRegistrationWizard.tsx"),
      "utf8",
    );
    const setup = readFileSync(resolve("src/components/vendor/BusinessSetupSheet.tsx"), "utf8");
    const myBiz = readFileSync(resolve("src/components/settings/VendorMyBusiness.tsx"), "utf8");
    expect(wizard).toContain("triggerCategoryModeConfidenceCheck");
    expect(setup).toContain("triggerCategoryModeConfidenceCheck");
    expect(myBiz).toContain("triggerCategoryModeConfidenceCheck");
  });

  it("admin Settings surfaces Mode Confidence Review with both actions", () => {
    const settings = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");
    expect(settings).toContain("admin_modeConfidenceReview");
    expect(settings).toContain("admin_confirm_category_mode_review");
    expect(settings).toContain("admin_dismiss_category_mode_review");
    expect(settings).toContain("admin_list_category_mode_vendors");
    expect(settings).toContain("openVendorInAdminList");
  });

  it("migration does not touch search/discovery RPCs", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260827180001_category_mode_reviews.sql"),
      "utf8",
    );
    expect(mig).toContain("category_mode_reviews");
    expect(mig).toContain("maybe_flag_category_mode_reviews");
    expect(mig).not.toMatch(/radar|search_vendors|feed_audience|create_request/i);
  });
});
