import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("VendorMyBusiness Phase 5 identity vs per-business split", () => {
  const src = readFileSync(resolve(__dirname, "VendorMyBusiness.tsx"), "utf8");
  const identityStart = src.indexOf('data-testid="my-business-identity-panel"');
  const identityEnd = src.indexOf("my-business-accordion-${cat.id}");
  const identity = src.slice(identityStart, identityEnd);
  const category = src.slice(identityEnd);

  it("#1 identity accordion keeps name, phone, selfie and drops UPI / QR / base_type / confirm location", () => {
    expect(identity).toContain("vendor_your_name");
    expect(identity).toContain("vendor_phone_label");
    expect(identity).toContain("vendor_selfie_title");
    expect(identity).not.toContain("vendor_upi_label");
    expect(identity).not.toContain("vendor_upi_qr_label");
    expect(identity).not.toContain("reg_where_work_from");
    expect(identity).not.toContain("my_business_confirm_location");
    expect(identity).not.toContain("patchVendorOwn(vendor.id, vendor.phone, patch)");
  });

  it("#2 category accordion edits UPI, optional QR, base_type, and location via vendor_update_categories", () => {
    expect(category).toContain("reg_where_work_from");
    expect(category).toContain("vendor_upi_label");
    expect(category).toContain("vendor_upi_qr_label");
    expect(category).toContain("my_business_confirm_location");
    expect(category).toContain("updateBusinessLocation");
    expect(src).toContain("p_upi_ids:");
    expect(src).toContain("p_base_types:");
    expect(src).toContain("p_latitudes:");
    expect(src).toContain('supabase.rpc("vendor_update_categories"');
    expect(src).not.toContain("upi_id: upiId.trim()");
  });

  it("#3a rejected categories stay visible but do not block Add Business picker", () => {
    expect(src).toContain('review_status ?? "approved") !== "rejected"');
    expect(src).toContain("existingCategoryIds={selectedCategoryIds.filter(");
  });

  it("#3 empty pre-Phase-2 UPI/base_type render without vendors.* backfill", () => {
    expect(src).toContain('upi_id: String(row.upi_id ?? "").trim()');
    expect(src).toContain("base_type: rowBaseType(row.base_type)");
    expect(src).not.toContain("setUpiId(v.upi_id");
    // Account selfie gate may still map vendors.vendor_type; category hydrate must not.
    expect(src).not.toContain("base_type: vendorTypeToBaseType");
    expect(src).not.toContain("upi_id: String(v.upi_id");
    expect(src).not.toContain("upi_id: v.upi_id");
    // Empty base_type must not coerce to "none" for shop_name (would wipe brand → Radar miss).
    expect(src).toContain('primaryCatSettings.base_type === ""');
    expect(src).not.toContain('primaryCatSettings.base_type || "none"');
  });

  it("#4 selfie stays account-gated; shop-photo location gate uses the business pin", () => {
    expect(identity).toContain("!hasAccountLocation && accountBaseType !== \"none\"");
    expect(category).toContain("!catHasLocation && cfg.base_type !== \"none\"");
    expect(src).toContain(
      "const catHasLocation = cfg.latitude != null && cfg.longitude != null",
    );
    expect(src).not.toContain("actionDisabled={!hasLocation");
  });
});
