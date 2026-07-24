import { describe, expect, it } from "vitest";
import {
  savedNeighbourDisplayName,
  markNeighboursDirty,
  consumeNeighboursDirty,
} from "@/lib/savedVendors";

describe("savedNeighbourDisplayName", () => {
  it("prefers trimmed nickname over shop name", () => {
    expect(savedNeighbourDisplayName("  My guy ", "Shop")).toBe("My guy");
  });

  it("falls back to shop name when nickname empty", () => {
    expect(savedNeighbourDisplayName("", "Real Shop")).toBe("Real Shop");
    expect(savedNeighbourDisplayName("   ", "Real Shop")).toBe("Real Shop");
    expect(savedNeighbourDisplayName(null, "Real Shop")).toBe("Real Shop");
  });
});

describe("markNeighboursDirty / consumeNeighboursDirty", () => {
  it("sets and consumes the dirty flag", () => {
    localStorage.clear();
    markNeighboursDirty();
    expect(localStorage.getItem("aaspaas:neighbours_dirty")).toBe("true");
    expect(consumeNeighboursDirty()).toBe(true);
    expect(consumeNeighboursDirty()).toBe(false);
  });
});
