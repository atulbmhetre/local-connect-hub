import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dismiss allows disputed; drops admin resolve", () => {
  const mig = readFileSync(
    resolve(
      "supabase/migrations/20260905300001_dismiss_allows_disputed_drop_admin_resolve.sql",
    ),
    "utf8",
  );

  it("drops admin_resolve_disputed_upi_payment", () => {
    expect(mig).toContain(
      "DROP FUNCTION IF EXISTS public.admin_resolve_disputed_upi_payment",
    );
  });

  it("exempts disputed from unpaid dismiss block on both RPCs", () => {
    expect(mig).toContain("dismiss_order");
    expect(mig).toContain("vendor_dismiss_requests");
    expect(mig).toMatch(/IS DISTINCT FROM 'disputed'/);
  });

  it("reverts requests.payment_status void added for admin write-off", () => {
    expect(mig).toContain(
      "CHECK (payment_status IN ('unpaid', 'claimed', 'confirmed', 'disputed'))",
    );
  });
});
