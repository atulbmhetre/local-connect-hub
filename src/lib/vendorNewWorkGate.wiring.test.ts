import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vendor_business_new_work_block wiring", () => {
  it("new-work helper is used by radar, resolve, and create_customer_request only", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260921230001_vendor_business_new_work_block.sql"),
      "utf8",
    );
    expect(mig).toContain("vendor_business_new_work_block");
    expect(mig).toContain("get_radar_category_mode_matches");
    expect(mig).toContain("_resolve_booking_category");
    expect(mig).toContain("create_customer_request");
    expect(mig).toContain("Does not inspect is_active or subscription_status");
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
    expect(mig).not.toMatch(/v\.subscription_status|\.eq\(\"subscription_status\"/);
  });

  it("history RPC source is unchanged by this migration", () => {
    const hist = readFileSync(
      resolve("supabase/migrations/20260717180001_radar_rls_health.sql"),
      "utf8",
    );
    expect(hist).toContain("get_vendors_visible_to_customer");
    expect(hist).not.toContain("vendor_business_new_work_block");
  });
});
