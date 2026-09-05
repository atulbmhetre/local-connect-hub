import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("create_customer_request drops dead is_active/profile_status", () => {
  const mig = readFileSync(
    resolve(
      "supabase/migrations/20260905290001_create_customer_request_drop_dead_active_checks.sql",
    ),
    "utf8",
  );

  it("removes dead is_active stub and unused profile_status load", () => {
    expect(mig).toContain("create_customer_request");
    expect(mig).not.toMatch(/v_vendor_active/);
    expect(mig).not.toMatch(/v_vendor_profile_status/);
    expect(mig).not.toMatch(/IF NOT v_vendor_active THEN/);
    expect(mig).not.toMatch(/COALESCE\(v\.is_active/);
    expect(mig).not.toMatch(/v\.profile_status/);
  });

  it("documents offline-but-discoverable bookable design", () => {
    expect(mig).toMatch(/Offline-but-discoverable Delivery\/Appointment/i);
    expect(mig).toMatch(/Help already filters offline/i);
    expect(mig).toContain("discoverable");
  });
});
