import { describe, expect, it } from "vitest";
import {
  applicableLicenseFields,
  applyLicenseConfidenceGate,
  licenseTypesForCategoryLabel,
  normalizeProposedLicenseType,
  parseLicenseFieldCategories,
  wizardLicenseFields,
} from "./vendorLicenses";

describe("vendor license field mapping", () => {
  it("maps Pharmacy to drug_license and ignores Help/Electrician", () => {
    const mapping = parseLicenseFieldCategories(null);
    expect(licenseTypesForCategoryLabel("Pharmacy", mapping)).toEqual(["drug_license"]);
    expect(licenseTypesForCategoryLabel("Electrician", mapping)).toEqual([]);
    expect(licenseTypesForCategoryLabel("Help", mapping)).toEqual([]);
  });

  it("builds one field group per matching selected business", () => {
    const mapping = parseLicenseFieldCategories(
      JSON.stringify({ Pharmacy: ["drug_license"], Grocery: ["fssai"] }),
    );
    const fields = applicableLicenseFields(
      [
        { id: "p", label: "Pharmacy" },
        { id: "e", label: "Electrician" },
        { id: "g", label: "Grocery" },
      ],
      mapping,
    );
    expect(fields.map((f) => f.fieldKey)).toEqual(["p:drug_license", "g:fssai"]);
  });

  it("gates specific licenses to generic below the category confidence threshold", () => {
    expect(normalizeProposedLicenseType("fssai")).toBe("FSSAI License");
    expect(normalizeProposedLicenseType("Shop & Establishment")).toBe("generic");
    expect(applyLicenseConfidenceGate("Drug License", 0.9, 0.85)).toBe("Drug License");
    expect(applyLicenseConfidenceGate("Drug License", 0.84, 0.85)).toBe("generic");
  });

  it("wizard always includes Shop & Establishment and only approved specific licenses", () => {
    const fields = wizardLicenseFields([
      {
        id: "p",
        label: "Pharmacy",
        license_type: "Drug License",
        license_review_status: "pending_review",
      },
      {
        id: "g",
        label: "Grocery",
        license_type: "FSSAI License",
        license_review_status: "approved",
      },
      {
        id: "e",
        label: "Electrician",
        license_type: "generic",
        license_review_status: "approved",
      },
    ]);
    expect(fields.map((f) => f.fieldKey)).toEqual([
      "p:shop_establishment",
      "g:fssai",
      "g:shop_establishment",
      "e:shop_establishment",
    ]);
  });
});
