import { describe, expect, it } from "vitest";
import { looksLikeGibberish } from "./vendorRegistration";

describe("looksLikeGibberish", () => {
  it("flags strings shorter than 2 chars", () => {
    expect(looksLikeGibberish("a")).toBe(true);
    expect(looksLikeGibberish(" ")).toBe(true);
  });

  it("flags Latin strings with no vowels", () => {
    expect(looksLikeGibberish("xzcvbn")).toBe(true);
    expect(looksLikeGibberish("qwrtstt")).toBe(true);
  });

  it("flags repeated-letter spam regardless of script", () => {
    expect(looksLikeGibberish("aaaa")).toBe(true);
    expect(looksLikeGibberish("hiiii")).toBe(true);
  });

  it("does not flag repeated digits (shop/plot/phone numbers)", () => {
    expect(looksLikeGibberish("Shop 0001")).toBe(false);
    expect(looksLikeGibberish("!VE-REMOVE-1785000000000")).toBe(false);
    expect(looksLikeGibberish("!SyncedShop-1785000000000")).toBe(false);
    expect(looksLikeGibberish("Plot 1111")).toBe(false);
  });

  it("flags keyboard-mash rows for Latin-only strings", () => {
    expect(looksLikeGibberish("asdfgh")).toBe(true);
    expect(looksLikeGibberish("qwertyu")).toBe(true);
  });

  it("accepts normal Latin names", () => {
    expect(looksLikeGibberish("Ramesh")).toBe(false);
    expect(looksLikeGibberish("Priya Traders")).toBe(false);
  });

  it("does not false-flag Devanagari names for missing Latin vowels", () => {
    expect(looksLikeGibberish("राज")).toBe(false);
    expect(looksLikeGibberish("श्री गणेश स्टोर्स")).toBe(false);
    expect(looksLikeGibberish("सुनीता")).toBe(false);
  });

  it("does not apply Latin keyboard-mash checks to Devanagari strings", () => {
    // Would match /^[asdfghjkl;]+$/ style rows if mistakenly Latin-cased.
    expect(looksLikeGibberish("अजय")).toBe(false);
  });

  it("still flags a short/empty-ish Devanagari string", () => {
    expect(looksLikeGibberish("अ")).toBe(true);
  });

  it("handles mixed Latin+Devanagari names", () => {
    expect(looksLikeGibberish("Raj राज")).toBe(false);
  });
});
