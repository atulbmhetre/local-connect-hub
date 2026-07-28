import { describe, expect, it } from "vitest";
import { categoryHasActiveVendor, offerMatchesCategory } from "@/lib/feedCategoryMatch";

describe("feedCategoryMatch", () => {
  it("categoryHasActiveVendor matches Kirana/Grocery alias pair", () => {
    const active = new Set(["Kirana Store"]);
    expect(categoryHasActiveVendor("Grocery Store", active)).toBe(true);
    expect(categoryHasActiveVendor("Plumber", active)).toBe(false);
  });

  it("offerMatchesCategory uses vendor_categories union when vendor id is mapped", () => {
    const map = new Map<string, Set<string>>([["v1", new Set(["Electrician"])]]);
    expect(offerMatchesCategory("v1", "Plumber", "Electrician", map)).toBe(true);
    expect(offerMatchesCategory("v1", "Plumber", "Plumber", map)).toBe(false);
  });

  it("offerMatchesCategory falls back to legacy vendors.category", () => {
    const map = new Map<string, Set<string>>();
    expect(offerMatchesCategory(null, "Mechanic", "Mechanic", map)).toBe(true);
    expect(offerMatchesCategory("v2", "Mechanic", "Plumber", map)).toBe(false);
  });

  it("offerMatchesCategory resolves grocery/kirana alias on chip label", () => {
    const map = new Map<string, Set<string>>([["v1", new Set(["Kirana Store"])]]);
    expect(offerMatchesCategory("v1", "Kirana Store", "Grocery Store", map)).toBe(true);
  });
});
