import { describe, expect, it } from "vitest";
import {
  VENDOR_LIVE_STALE_MS,
  isVendorEffectivelyLive,
  isVendorLiveLocationFresh,
  liveLocationFreshSinceIso,
} from "@/lib/vendorLiveStaleness";

describe("vendor live GPS staleness (H5)", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");

  it("treats missing/invalid last_updated as stale", () => {
    expect(isVendorLiveLocationFresh(null, now)).toBe(false);
    expect(isVendorLiveLocationFresh(undefined, now)).toBe(false);
    expect(isVendorLiveLocationFresh("not-a-date", now)).toBe(false);
  });

  it("keeps a vendor live within the 45-minute freshness window", () => {
    const fresh = new Date(now - 20 * 60 * 1000).toISOString();
    expect(isVendorLiveLocationFresh(fresh, now)).toBe(true);
    expect(
      isVendorEffectivelyLive({ is_active: true, last_updated: fresh }, now),
    ).toBe(true);
  });

  it("excludes a live-flagged vendor whose GPS is older than the threshold", () => {
    const stale = new Date(now - VENDOR_LIVE_STALE_MS - 1).toISOString();
    expect(isVendorLiveLocationFresh(stale, now)).toBe(false);
    expect(
      isVendorEffectivelyLive({ is_active: true, last_updated: stale }, now),
    ).toBe(false);
  });

  it("never treats is_active=false as effectively live even with fresh GPS", () => {
    const fresh = new Date(now - 60_000).toISOString();
    expect(
      isVendorEffectivelyLive({ is_active: false, last_updated: fresh }, now),
    ).toBe(false);
  });

  it("liveLocationFreshSinceIso is exactly VENDOR_LIVE_STALE_MS behind now", () => {
    expect(liveLocationFreshSinceIso(now)).toBe(
      new Date(now - VENDOR_LIVE_STALE_MS).toISOString(),
    );
  });
});
