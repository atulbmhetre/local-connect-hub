import { describe, expect, it } from "vitest";
import type { Vendor } from "@/lib/supabase";
import { PAN_INDIA_RADIUS_KM } from "@/lib/serviceRadius";
import {
  excludeOfflineHelpVendors,
  isPanIndiaServiceRadius,
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

describe("passesTrackARadiusFilter (Track A)", () => {
  it("excludes vendor when distance exceeds vendor radius even if within user bracket", () => {
    // radius 5 km, user bracket 25 km, vendor 30 km away → cap is min(25,5)=5
    expect(passesTrackARadiusFilter(30, 25, 5)).toBe(false);
  });

  it("includes vendor when within user bracket and vendor radius is wider", () => {
    // radius 50 km, user bracket 25 km, vendor 20 km away → cap is min(25,50)=25
    expect(passesTrackARadiusFilter(20, 25, 50)).toBe(true);
  });

  it("excludes vendor at edge beyond user bracket when bracket is tighter than vendor radius", () => {
    expect(passesTrackARadiusFilter(26, 25, 50)).toBe(false);
  });

  it("routes pan-India vendors to Track B (not Track A distance filter)", () => {
    expect(passesTrackARadiusFilter(500, 25, PAN_INDIA_RADIUS_KM)).toBe(false);
    expect(isPanIndiaServiceRadius(PAN_INDIA_RADIUS_KM)).toBe(true);
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
