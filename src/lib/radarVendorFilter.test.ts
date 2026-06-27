import { describe, expect, it } from "vitest";
import type { Vendor } from "@/lib/supabase";
import {
  excludeOfflineHelpVendors,
  mergeRadarTracks,
  passesTrackARadiusFilter,
} from "@/lib/radarVendorFilter";

function vendorSlice(
  overrides: Partial<Pick<Vendor, "is_active" | "service_mode" | "service_radius_km">> = {},
): Pick<Vendor, "is_active" | "service_mode" | "service_radius_km"> {
  return {
    is_active: true,
    service_mode: "delivery",
    service_radius_km: 15,
    ...overrides,
  };
}

describe("passesTrackARadiusFilter", () => {
  it("hides vendor when customer is beyond vendor service radius", () => {
    expect(passesTrackARadiusFilter(6, 15, 5)).toBe(false);
  });

  it("shows vendor when customer is within vendor service radius", () => {
    expect(passesTrackARadiusFilter(4, 15, 5)).toBe(true);
  });

  it("respects user bracket when tighter than vendor radius", () => {
    expect(passesTrackARadiusFilter(8, 5, 50)).toBe(false);
  });

  it("shows vendor when within both user bracket and vendor radius", () => {
    expect(passesTrackARadiusFilter(4, 5, 50)).toBe(true);
  });

  it("returns false for pan-india vendor in track A", () => {
    expect(passesTrackARadiusFilter(1, 15, 9999)).toBe(false);
  });

  it("uses default radius when vendor radius is null", () => {
    // null normalizes to DEFAULT_SERVICE_RADIUS_KM (15)
    expect(passesTrackARadiusFilter(10, 15, null)).toBe(true);
    expect(passesTrackARadiusFilter(16, 15, null)).toBe(false);
  });

  it("passes when customer is exactly at vendor radius boundary", () => {
    expect(passesTrackARadiusFilter(5, 15, 5)).toBe(true); // dist === radius
  });

  it("fails when user bracket is tighter than vendor radius", () => {
    expect(passesTrackARadiusFilter(3, 2, 50)).toBe(false); // user bracket wins
  });

  it("passes when customer is at zero distance (same location)", () => {
    expect(passesTrackARadiusFilter(0, 15, 5)).toBe(true);
  });

  it("fails when distance is just beyond vendor radius", () => {
    expect(passesTrackARadiusFilter(5.1, 15, 5)).toBe(false);
  });
});

describe("mergeRadarTracks (Pan-India Track B)", () => {
  const local = { id: "local", isPanIndia: false };
  const panIndia = { id: "pan", isPanIndia: true };

  it("includes pan-India vendors alongside local results for any bracket", () => {
    const merged = mergeRadarTracks([], [panIndia], false);
    expect(merged).toEqual([panIndia]);
  });

  it("includes pan-India vendors when user selects pan-India bracket only", () => {
    const merged = mergeRadarTracks([local], [panIndia], true);
    expect(merged).toEqual([panIndia]);
  });

  it("excludes non-pan-India vendors when pan-India-only bracket is selected", () => {
    const merged = mergeRadarTracks([local], [], true);
    expect(merged).toEqual([]);
  });

  it("merges local Track A and pan-India Track B for standard brackets", () => {
    const merged = mergeRadarTracks([local], [panIndia], false);
    expect(merged).toEqual([local, panIndia]);
  });
});

describe("excludeOfflineHelpVendors (offline appointment rule)", () => {
  it("keeps offline appointment vendors in radar candidate set", () => {
    const vendors = [
      vendorSlice({ is_active: false, service_mode: "appointment" }),
      vendorSlice({ is_active: false, service_mode: "delivery" }),
    ];
    expect(excludeOfflineHelpVendors(vendors)).toHaveLength(2);
  });

  it("excludes offline help vendors from radar candidate set", () => {
    const vendors = [
      vendorSlice({ is_active: false, service_mode: "help" }),
      vendorSlice({ is_active: true, service_mode: "help" }),
    ];
    expect(excludeOfflineHelpVendors(vendors)).toEqual([vendors[1]]);
  });
});
