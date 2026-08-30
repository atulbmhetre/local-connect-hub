import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vendor business soft-cap wiring", () => {
  it("Add Business is no longer hard-disabled at 5", () => {
    const my = readFileSync(resolve("src/components/settings/VendorMyBusiness.tsx"), "utf8");
    const sheet = readFileSync(resolve("src/components/vendor/BusinessSetupSheet.tsx"), "utf8");
    expect(my).toContain("VENDOR_BUSINESS_SOFT_CAP");
    expect(my).not.toMatch(/disabled=\{selectedCategoryIds\.length >= MAX_VENDOR_CATEGORIES\}/);
    expect(sheet).toContain("needsAdminReview");
    expect(sheet).not.toContain("atMax");
  });

  it("admin queue is its own Pending Businesses section", () => {
    const settings = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");
    expect(settings).toContain("admin_pendingBusinesses");
    expect(settings).toContain("admin_list_pending_vendor_businesses");
    expect(settings).toContain("admin_approve_vendor_business");
  });

  it("migration uses insert trigger not a hard RPC exception at 5", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830150001_vendor_business_soft_cap.sql"),
      "utf8",
    );
    expect(mig).toContain("_vendor_category_soft_cap_bi");
    expect(mig).toContain("admin_list_pending_vendor_businesses");
    expect(mig).toContain("admin_approve_vendor_business");
    expect(mig).toContain("admin_reject_vendor_business");
    expect(mig).toContain("pending_review");
    expect(mig).not.toMatch(/RAISE EXCEPTION 'too_many_categories'/);
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
  });
});
