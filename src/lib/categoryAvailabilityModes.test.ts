import { describe, expect, it } from "vitest";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  ensureCatalogBaseModes,
  helpAppointmentChoiceToModes,
  helpAppointmentModesToChoice,
  initialModesForCatalog,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
  toggleAvailabilityMode,
  unionAvailabilityModes,
} from "@/lib/categoryAvailabilityModes";

describe("categoryAvailabilityModes", () => {
  it("normalizeAvailabilityModes dedupes and orders", () => {
    expect(normalizeAvailabilityModes(["appointment", "help", "help", "bogus"])).toEqual([
      "help",
      "appointment",
    ]);
  });

  it("pickPrimaryAvailabilityMode prefers catalog when present", () => {
    expect(pickPrimaryAvailabilityMode(["appointment", "help"], "help")).toBe("help");
    expect(pickPrimaryAvailabilityMode(["appointment"], "help")).toBe("appointment");
  });

  it("toggleAvailabilityMode keeps at least one by default", () => {
    expect(toggleAvailabilityMode(["help"], "help")).toEqual(["help"]);
    expect(toggleAvailabilityMode(["help", "appointment"], "help")).toEqual(["appointment"]);
  });

  it("allCategoriesHaveModes requires every selected category", () => {
    expect(allCategoriesHaveModes(["a", "b"], { a: ["help"], b: [] })).toBe(false);
    expect(allCategoriesHaveModes(["a", "b"], { a: ["help"], b: ["delivery"] })).toBe(true);
  });

  it("buildCategoryModesPayload emits normalized arrays", () => {
    expect(
      buildCategoryModesPayload(["c1"], { c1: ["appointment", "help", "help"] }),
    ).toEqual({ c1: ["help", "appointment"] });
  });

  it("unionAvailabilityModes merges across categories", () => {
    expect(
      unionAvailabilityModes({
        a: ["help"],
        b: ["appointment", "delivery"],
      }),
    ).toEqual(["help", "delivery", "appointment"]);
  });

  it("initialModesForCatalog leaves help/appointment unset until the vendor picks", () => {
    expect(initialModesForCatalog("help")).toEqual([]);
    expect(initialModesForCatalog("appointment")).toEqual([]);
    expect(initialModesForCatalog("delivery")).toEqual(["delivery"]);
  });

  it("ensureCatalogBaseModes allows urgent-only, scheduled-only, or both", () => {
    expect(ensureCatalogBaseModes(["appointment"], "help")).toEqual(["appointment"]);
    expect(ensureCatalogBaseModes(["help"], "help")).toEqual(["help"]);
    expect(ensureCatalogBaseModes(["help", "appointment"], "help")).toEqual([
      "help",
      "appointment",
    ]);
    expect(ensureCatalogBaseModes([], "help")).toEqual([]);
    expect(ensureCatalogBaseModes(["help"], "appointment")).toEqual(["help"]);
    expect(ensureCatalogBaseModes([], "appointment")).toEqual([]);
  });

  it("ensureCatalogBaseModes for delivery-default is delivery or pickup appointment", () => {
    expect(ensureCatalogBaseModes(["delivery"], "delivery")).toEqual(["delivery"]);
    expect(ensureCatalogBaseModes(["appointment"], "delivery")).toEqual(["appointment"]);
    expect(ensureCatalogBaseModes([], "delivery")).toEqual(["delivery"]);
  });

  it("helpAppointment choice maps both ways", () => {
    expect(helpAppointmentModesToChoice([])).toBeNull();
    expect(helpAppointmentModesToChoice(["help"])).toBe("urgent");
    expect(helpAppointmentModesToChoice(["appointment"])).toBe("scheduled");
    expect(helpAppointmentModesToChoice(["help", "appointment"])).toBe("both");
    expect(helpAppointmentChoiceToModes("urgent")).toEqual(["help"]);
    expect(helpAppointmentChoiceToModes("scheduled")).toEqual(["appointment"]);
    expect(helpAppointmentChoiceToModes("both")).toEqual(["help", "appointment"]);
  });
});
