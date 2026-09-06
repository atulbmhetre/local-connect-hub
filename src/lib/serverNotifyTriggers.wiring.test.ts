import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("server notify triggers wiring", () => {
  const migrationPath = resolve(
    "supabase/migrations/20260905100001_server_trigger_remaining_notifies.sql",
  );

  it("migration 20260905100001 exists with shared edge helpers and lifecycle triggers", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const mig = readFileSync(migrationPath, "utf8");
    expect(mig).toContain("_edge_notify_keys");
    expect(mig).toContain("_pg_net_notify_user");
    expect(mig).toContain("_pg_net_notify_vendor");
    expect(mig).toContain("_pg_net_notify_admin");
    expect(mig).toContain("notify_vendor_on_referral_credit");
    expect(mig).toContain("notify_on_request_lifecycle");
    expect(mig).toContain("notify_user_on_moderation");
    expect(mig).toContain("notify_on_vendor_changes");
    expect(mig).toContain("notify_vendor_on_low_rating");
    expect(mig).toContain("notify_user_on_khata_cleared");
    expect(mig).toContain("AFTER INSERT ON public.vendor_credits");
    expect(mig).toContain("AFTER UPDATE ON public.requests");
  });

  it("referral.ts no longer client-invokes notify-vendor (DB trigger owns it)", () => {
    const referral = readFileSync(resolve("src/lib/referral.ts"), "utf8");
    expect(referral).not.toContain("invokeNotifyVendor");
  });
});
