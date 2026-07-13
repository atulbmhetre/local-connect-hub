import { describe, expect, it } from "vitest";
import {
  CUSTOMER_FEED_REACH_CHIP_OPTIONS,
  FEED_REACH_CITY_WIDE_KM,
  MAX_CUSTOMER_FEED_REACH_KM,
  VENDOR_FEED_REACH_CHIP_OPTIONS,
  clampCustomerFeedReachKm,
} from "./feedReach";

describe("R4 — customer reach is modest; vendor offers may go city-wide", () => {
  it("customer compose options are modest radii only — never city/nationwide", () => {
    expect(CUSTOMER_FEED_REACH_CHIP_OPTIONS).toEqual([1, 2, 5, 10, 25]);
    expect(CUSTOMER_FEED_REACH_CHIP_OPTIONS).not.toContain(FEED_REACH_CITY_WIDE_KM);
    expect(MAX_CUSTOMER_FEED_REACH_KM).toBe(25);
  });

  it("vendor offer options include every modest radius plus full city / nationwide", () => {
    expect(VENDOR_FEED_REACH_CHIP_OPTIONS).toEqual([1, 2, 5, 10, 25, FEED_REACH_CITY_WIDE_KM]);
    expect(VENDOR_FEED_REACH_CHIP_OPTIONS).toContain(FEED_REACH_CITY_WIDE_KM);
  });

  it("clamping a customer reach never stores city/nationwide even if requested", () => {
    expect(clampCustomerFeedReachKm(FEED_REACH_CITY_WIDE_KM)).toBe(25);
    expect(clampCustomerFeedReachKm(9999)).toBe(25);
    expect(clampCustomerFeedReachKm(100)).toBe(25);
    expect(clampCustomerFeedReachKm(10)).toBe(10);
    expect(clampCustomerFeedReachKm(null)).toBe(5);
  });
});
