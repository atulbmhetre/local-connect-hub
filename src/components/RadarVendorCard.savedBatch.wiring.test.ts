import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Radar saved-vendor batching", () => {
  const cardSrc = readFileSync(
    resolve("src/components/RadarVendorCard.tsx"),
    "utf8",
  );
  const radarSrc = readFileSync(resolve("src/pages/RadarSearch.tsx"), "utf8");

  it("does not call get_saved_vendors from each RadarVendorCard", () => {
    expect(cardSrc).not.toContain('rpc("get_saved_vendors"');
  });

  it("loads saved vendors once at the RadarSearch parent level", () => {
    expect(radarSrc).toContain('rpc("get_saved_vendors"');
    expect(radarSrc).toContain("refreshSavedVendorIds");
    expect(radarSrc).toContain("savedVendorIds");
  });
});
