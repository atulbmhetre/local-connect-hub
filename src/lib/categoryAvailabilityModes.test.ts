import { describe, expect, it } from "vitest";
import { HELP_DEFAULT_CATEGORY_LABELS } from "@/lib/categories";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  ensureCatalogBaseModes,
  initialModesForCatalog,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
  resolveCatalogServiceMode,
  toggleAvailabilityMode,
  unionAvailabilityModes,
} from "@/lib/categoryAvailabilityModes";

describe("categoryAvailabilityModes", () => {
  it("normalizes and orders modes", () => {
    expect(normalizeAvailabilityModes(["appointment", "help", "help", "bogus"])).toEqual([
      "help",
      "appointment",
    ]);
  });

  it("picks catalog mode when selected", () => {
    expect(pickPrimaryAvailabilityMode(["delivery", "help"], "help")).toBe("help");
    expect(pickPrimaryAvailabilityMode(["delivery", "appointment"], "help")).toBe("delivery");
  });

  it("toggleAvailabilityMode adds and removes modes independently", () => {
    expect(toggleAvailabilityMode([], "help")).toEqual(["help"]);
    expect(toggleAvailabilityMode(["help"], "appointment")).toEqual(["help", "appointment"]);
    expect(toggleAvailabilityMode(["help", "appointment"], "help")).toEqual(["appointment"]);
    expect(toggleAvailabilityMode(["help"], "help")).toEqual(["help"]);
    expect(toggleAvailabilityMode(["help"], "help", { allowEmpty: true })).toEqual([]);
  });

  it("selecting only Help yields exactly one mode", () => {
    const afterHelpOnly = toggleAvailabilityMode([], "help");
    expect(afterHelpOnly).toEqual(["help"]);
    expect(buildCategoryModesPayload(["cat-1"], { "cat-1": afterHelpOnly })).toEqual({
      "cat-1": ["help"],
    });
  });

  it("builds payload with full multi-mode arrays per category", () => {
    const ids = ["a", "b"];
    const map = {
      a: ["help" as const],
      b: ["delivery" as const, "appointment" as const],
    };
    expect(allCategoriesHaveModes(ids, map)).toBe(true);
    expect(allCategoriesHaveModes(ids, { a: ["help"], b: [] })).toBe(false);
    expect(buildCategoryModesPayload(ids, map)).toEqual({
      a: ["help"],
      b: ["delivery", "appointment"],
    });
  });

  it("unions modes across categories", () => {
    expect(
      unionAvailabilityModes({
        a: ["appointment"],
        b: ["delivery", "help"],
      }),
    ).toEqual(["help", "delivery", "appointment"]);
  });

  it("resolveCatalogServiceMode maps booking to appointment", () => {
    expect(resolveCatalogServiceMode("booking")).toBe("appointment");
    expect(resolveCatalogServiceMode("help")).toBe("help");
  });

  it("initialModesForCatalog matches catalog defaults", () => {
    expect(initialModesForCatalog("help")).toEqual(["help"]);
    expect(initialModesForCatalog("delivery")).toEqual(["delivery"]);
    expect(initialModesForCatalog("appointment")).toEqual(["appointment"]);
  });

  it("ensureCatalogBaseModes keeps help on for help-default categories", () => {
    expect(ensureCatalogBaseModes(["appointment"], "help")).toEqual(["help", "appointment"]);
    expect(ensureCatalogBaseModes(["delivery", "help"], "help")).toEqual(["help"]);
    expect(ensureCatalogBaseModes([], "help")).toEqual(["help"]);
  });

  it("ensureCatalogBaseModes for delivery-default is delivery or pickup appointment", () => {
    expect(ensureCatalogBaseModes(["delivery"], "delivery")).toEqual(["delivery"]);
    expect(ensureCatalogBaseModes(["appointment"], "delivery")).toEqual(["appointment"]);
    expect(ensureCatalogBaseModes([], "delivery")).toEqual(["delivery"]);
  });

  it("ensureCatalogBaseModes for appointment-default adds optional help", () => {
    expect(ensureCatalogBaseModes(["help"], "appointment")).toEqual(["appointment", "help"]);
    expect(ensureCatalogBaseModes([], "appointment")).toEqual(["appointment"]);
  });

  it("HELP_DEFAULT_CATEGORY_LABELS includes mechanic and excludes grocery", () => {
    expect(HELP_DEFAULT_CATEGORY_LABELS).toContain("Mechanic");
    expect(HELP_DEFAULT_CATEGORY_LABELS).toContain("Electrician");
    expect(HELP_DEFAULT_CATEGORY_LABELS).not.toContain("Grocery Store");
    expect(HELP_DEFAULT_CATEGORY_LABELS).not.toContain("Beautician");
  });
});
