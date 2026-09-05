import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VENDOR_LIVE_STALE_MS } from "@/lib/vendorLiveStaleness";

describe("deactivate_stale_live_vendors wiring (H5)", () => {
  const mig = readFileSync(
    resolve("supabase/migrations/20260905240001_deactivate_stale_live_vendors.sql"),
    "utf8",
  );

  it("schedules a server cron that clears is_active on stale last_updated", () => {
    expect(mig).toContain("deactivate_stale_live_vendors");
    expect(mig).toContain("vendor_live_stale_minutes");
    expect(mig).toContain("is_active = false");
    expect(mig).toContain("last_updated IS NULL");
    expect(mig).toContain("deactivate-stale-live-vendors");
    expect(mig).toContain("*/5 * * * *");
  });

  it("defaults the threshold to 45 minutes matching the client constant", () => {
    expect(VENDOR_LIVE_STALE_MS).toBe(45 * 60 * 1000);
    expect(mig).toMatch(/VALUES\s*\(\s*'vendor_live_stale_minutes',\s*'45'/);
  });
});
