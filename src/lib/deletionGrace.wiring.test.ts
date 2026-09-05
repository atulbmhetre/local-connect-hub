import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("deletion grace wiring", () => {
  it("migration gates placement and finalizes customer deletion side-effects", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260905230001_deletion_grace_behavior.sql"),
      "utf8",
    );
    expect(mig).toContain("customer_deletion_scheduled");
    expect(mig).toContain("vendor_deletion_scheduled");
    expect(mig).toContain("finalize_customer_deletion_request");
    expect(mig).toContain("customer_deletion_khata_outstanding");
    expect(mig).toContain("status = 'cancelled'");
  });

  it("delete-account edge calls finalize after scheduling customer deletion", () => {
    const edge = readFileSync(resolve("supabase/functions/delete-account/index.ts"), "utf8");
    expect(edge).toContain("finalize_customer_deletion_request");
  });

  it("Settings confirm copy warns about cancel + khata; Parchi maps clear errors", () => {
    const strings = readFileSync(resolve("src/lib/strings.ts"), "utf8");
    expect(strings).toContain("open orders will be cancelled");
    expect(strings).toContain("parchi_errCustomerDeletionScheduled");
    expect(strings).toContain("parchi_errVendorDeletionScheduled");

    const place = readFileSync(resolve("src/lib/executeOrderInsert.ts"), "utf8");
    expect(place).toContain("customer_deletion_scheduled");
    expect(place).toContain("vendor_deletion_scheduled");
  });
});
