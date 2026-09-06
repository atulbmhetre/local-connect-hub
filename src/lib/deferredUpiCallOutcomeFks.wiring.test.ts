import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("deferred upi/call-outcome FKs wiring", () => {
  it("migration adds both FKs with orphan gate and intended ON DELETE", () => {
    const mig = readFileSync(
      resolve(
        "supabase/migrations/20260905200001_add_deferred_upi_alerts_and_call_outcomes_fks.sql",
      ),
      "utf8",
    );
    expect(mig).toContain("upi_change_alerts_vendor_id_fkey");
    expect(mig).toContain("vendor_call_outcomes_request_id_fkey");
    expect(mig).toContain("ON DELETE NO ACTION");
    expect(mig).toContain("ON DELETE SET NULL");
    expect(mig).toMatch(/refusing deferred FKs|must both be 0/);
  });
});
