import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_ADDRESS_TEXT_CHARS } from "@/lib/addressLimits";

describe("M-tier address/bill/referral migration wiring", () => {
  const mig = readFileSync(
    resolve("supabase/migrations/20260905250001_m_tier_address_bill_referral.sql"),
    "utf8",
  );

  it("adds 500-char address CHECKs matching client constant", () => {
    expect(MAX_ADDRESS_TEXT_CHARS).toBe(500);
    expect(mig).toContain("user_addresses_address_text_max_len");
    expect(mig).toContain("requests_delivery_address_max_len");
    expect(mig).toContain("char_length(address_text) <= 500");
  });

  it("gates vendor_mark_bill_paid on unpaid status", () => {
    expect(mig).toContain("ob.payment_status = 'unpaid'");
    expect(mig).toContain("bill_not_unpaid");
    expect(mig).toContain("_assert_vendor_session_matches");
  });

  it("blocks banned or deletion-scheduled referral referrers", () => {
    expect(mig).toContain("referrer_banned");
    expect(mig).toContain("referrer_deletion_scheduled");
    expect(mig).toContain("deletion_requested_at");
    expect(mig).toContain("_assert_session_matches_claimed_phone");
  });
});
