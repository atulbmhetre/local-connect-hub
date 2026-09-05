import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("drop dead vendor RPCs wiring", () => {
  it("migration revokes grants and drops fulfill + khata bills paid", () => {
    const mig = readFileSync(
      resolve(
        "supabase/migrations/20260905130001_drop_dead_vendor_fulfill_and_khata_bills_paid.sql",
      ),
      "utf8",
    );
    expect(mig).toContain("REVOKE ALL ON FUNCTION public.vendor_fulfill_order");
    expect(mig).toContain(
      "REVOKE ALL ON FUNCTION public.vendor_mark_customer_khata_bills_paid",
    );
    expect(mig).toContain("DROP FUNCTION IF EXISTS public.vendor_fulfill_order");
    expect(mig).toContain(
      "DROP FUNCTION IF EXISTS public.vendor_mark_customer_khata_bills_paid",
    );
  });

  it("OTP checklist no longer lists the dropped RPCs", () => {
    const doc = readFileSync(resolve("docs/OTP_MIGRATION_CHECKLIST.md"), "utf8");
    expect(doc).not.toContain("vendor_fulfill_order");
    expect(doc).not.toContain("vendor_mark_customer_khata_bills_paid");
  });
});
