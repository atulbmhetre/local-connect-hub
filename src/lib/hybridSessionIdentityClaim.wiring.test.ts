import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RPCs = [
  "register_vendor",
  "ensure_user_device_link",
  "upsert_app_user",
  "get_vendor_by_phone_login",
  "migrate_saved_vendors_phone",
  "migrate_device_requests_phone",
  "apply_user_referral",
] as const;

describe("hybrid session identity-claim RPCs wiring", () => {
  it("migration targets exactly the seven identity-claiming RPCs", () => {
    const mig = readFileSync(
      resolve(
        "supabase/migrations/20260905190001_hybrid_session_identity_claim_rpcs.sql",
      ),
      "utf8",
    );
    expect(mig).toContain("_assert_session_matches_claimed_phone");
    for (const name of RPCs) {
      expect(mig).toContain(`'${name}'`);
    }
    expect(mig).toMatch(/NOT in scope:.*get_vendor_deletion_status/i);
    expect(mig).toMatch(/NOT in scope:.*vendor_fulfil_order/i);
    expect(mig).toMatch(/auth_user_phone|Soft hybrid/i);
  });
});
