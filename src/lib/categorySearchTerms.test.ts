import { describe, expect, it, beforeEach } from "vitest";
import {
  resolveCanonicalTerm,
  resolveCanonicalTerms,
  resolveFuzzyCanonicalTermsLocal,
  KNOWN_CATEGORIES,
} from "@/lib/categories";
import {
  searchTermsFromKnownSeed,
  setCategorySearchTermsCacheForTests,
  trigramSimilarity,
} from "@/lib/categorySearchTerms";

describe("resolveCanonicalTerms (DB-shaped / multi-match)", () => {
  beforeEach(() => {
    setCategorySearchTermsCacheForTests(searchTermsFromKnownSeed());
  });

  it("returns all matching categories when the same term maps to multiple rows", () => {
    setCategorySearchTermsCacheForTests([
      {
        category_id: "id-dairy",
        term: "milk",
        label: "Dairy",
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      },
      {
        category_id: "id-milkman",
        term: "milk",
        label: "Milkman",
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      },
      {
        category_id: "id-other",
        term: "tea",
        label: "Cloud Kitchen",
        language: "en",
        source: "manual",
        status: "active",
        confidence: null,
      },
    ]);
    const hits = resolveCanonicalTerms("need milk");
    expect(hits.map((h) => h.label).sort()).toEqual(["Dairy", "Milkman"]);
  });

  it("matches substring both directions (legacy phrase → mechanic)", () => {
    expect(resolveCanonicalTerm("I am looking for bike mechanic")).toBe("Mechanic");
    expect(resolveCanonicalTerms("mechanic").some((h) => h.label === "Mechanic")).toBe(
      true,
    );
  });

  it("does not treat typos as exact/substring matches", () => {
    expect(resolveCanonicalTerms("mecanik")).toEqual([]);
    expect(resolveCanonicalTerms("electrisian")).toEqual([]);
    expect(resolveCanonicalTerms("plumer")).toEqual([]);
  });

  it("seeds 85 aliases from KNOWN_CATEGORIES fallback", () => {
    const rows = searchTermsFromKnownSeed();
    expect(rows).toHaveLength(
      Object.values(KNOWN_CATEGORIES).reduce((n, c) => n + c.aliases.length, 0),
    );
    expect(rows.length).toBe(85);
  });
});

describe("resolveFuzzyCanonicalTermsLocal (Phase 6 typo tier)", () => {
  beforeEach(() => {
    setCategorySearchTermsCacheForTests(searchTermsFromKnownSeed());
  });

  it("resolves realistic typos above threshold", () => {
    expect(resolveFuzzyCanonicalTermsLocal("mecanik").some((h) => h.label === "Mechanic")).toBe(
      true,
    );
    expect(
      resolveFuzzyCanonicalTermsLocal("electrisian").some((h) => h.label === "Electrician"),
    ).toBe(true);
    expect(resolveFuzzyCanonicalTermsLocal("plumer").some((h) => h.label === "Plumber")).toBe(
      true,
    );
  });

  it("does not over-match short/common tokens or unrelated noise", () => {
    expect(resolveFuzzyCanonicalTermsLocal("car")).toEqual([]);
    expect(resolveFuzzyCanonicalTermsLocal("tap")).toEqual([]);
    expect(resolveFuzzyCanonicalTermsLocal("xyzzy")).toEqual([]);
    expect(resolveFuzzyCanonicalTermsLocal("repair").map((h) => h.label)).not.toContain(
      "Mechanic",
    );
    // Common English near-miss of an alias must not surface Beautician.
    expect(resolveFuzzyCanonicalTermsLocal("message").map((h) => h.label)).not.toContain(
      "Beautician",
    );
  });

  it("scores mechanic typo higher than plumber", () => {
    const mech = trigramSimilarity("mecanik", "mechanic");
    const plumb = trigramSimilarity("mecanik", "plumber");
    expect(mech).toBeGreaterThan(plumb);
    expect(mech).toBeGreaterThanOrEqual(0.3);
  });
});
