import { describe, expect, it } from "vitest";
import {
  allCategoriesHaveModes,
  buildCategoryModesPayload,
  coerceSingleAvailabilityMode,
  normalizeAvailabilityModes,
  pickPrimaryAvailabilityMode,
  setAvailabilityMode,
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

  it("setAvailabilityMode replaces prior selection (uniselect)", () => {
    expect(setAvailabilityMode("help")).toEqual(["help"]);
    expect(setAvailabilityMode("delivery")).toEqual(["delivery"]);
    expect(toggleAvailabilityMode(["help"], "delivery")).toEqual(["delivery"]);
    expect(toggleAvailabilityMode(["help", "delivery"], "appointment")).toEqual([
      "appointment",
    ]);
  });

  it("coerceSingleAvailabilityMode collapses multi-mode legacy lists", () => {
    expect(coerceSingleAvailabilityMode(["help", "delivery"], "delivery")).toEqual([
      "delivery",
    ]);
    expect(coerceSingleAvailabilityMode(["appointment", "help"])).toEqual(["help"]);
  });

  it("builds payload as single-element arrays per category", () => {
    const ids = ["a", "b"];
    const map = { a: ["help" as const], b: ["delivery" as const, "appointment" as const] };
    expect(allCategoriesHaveModes(ids, map)).toBe(true);
    expect(allCategoriesHaveModes(ids, { a: ["help"], b: [] })).toBe(false);
    expect(buildCategoryModesPayload(ids, map)).toEqual({
      a: ["help"],
      b: ["delivery"],
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
