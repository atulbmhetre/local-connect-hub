import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hybrid session missed RPCs wiring", () => {
  it("migration adds soft hybrid asserts to deletion status and fulfil", () => {
    const mig = readFileSync(
      resolve(
        "supabase/migrations/20260905120001_hybrid_session_deletion_status_and_fulfil.sql",
      ),
      "utf8",
    );
    expect(mig).toContain("get_vendor_deletion_status");
    expect(mig).toContain("_assert_vendor_session_matches_phone(p_phone)");
    expect(mig).toContain("vendor_fulfil_order");
    expect(mig).toContain("_assert_vendor_session_matches(p_vendor_id, p_vendor_phone)");
    expect(mig).toMatch(/auth_user_phone|Soft hybrid/i);
  });

  it("live callers still use the hybridized RPCs", () => {
    const settings = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");
    expect(settings).toContain('rpc("get_vendor_deletion_status"');
    const incoming = readFileSync(
      resolve("src/components/IncomingOrdersSection.tsx"),
      "utf8",
    );
    expect(incoming).toContain('rpc("vendor_fulfil_order"');
  });
});
