import { describe, expect, it } from "vitest";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
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

  it("toggles without emptying when allowEmpty is false", () => {
    expect(toggleAvailabilityMode(["help"], "help")).toEqual(["help"]);
    expect(toggleAvailabilityMode(["help"], "delivery")).toEqual(["help", "delivery"]);
  });

  it("builds payload and validates all categories have modes", () => {
    const ids = ["a", "b"];
    const map = { a: ["help" as const], b: ["delivery" as const, "appointment" as const] };
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
});
