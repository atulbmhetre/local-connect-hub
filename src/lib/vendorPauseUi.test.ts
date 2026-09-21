import { describe, expect, it } from "vitest";
import { en } from "@/lib/strings/en";
import {
  fillPauseTemplate,
  pauseErrorCode,
  parseResumeOutcome,
  parseVendorPausePreflight,
  resumePauseToast,
  shouldShowPauseLedgerNote,
  subscriptionPauseBlockMessage,
} from "@/lib/vendorPauseUi";

describe("vendorPauseUi", () => {
  it("fills {N} / {X} / {Y} in pause copy", () => {
    expect(fillPauseTemplate(en.vendor_pause_note, { N: 7 })).toContain("7 days or more");
    expect(fillPauseTemplate(en.vendor_pause_resume_credited, { X: 7 })).toBe(
      "Subscription extended by 7 days",
    );
    expect(fillPauseTemplate(en.vendor_pause_resume_under_min, { Y: 6, N: 7 })).toBe(
      "Paused 6 days, under 7, no extension",
    );
  });

  it("maps pause_blocked_* from PostgREST errors", () => {
    expect(pauseErrorCode({ message: "pause_blocked_open_work" })).toBe(
      "pause_blocked_open_work",
    );
    expect(
      pauseErrorCode({
        message: "pause_blocked_subscription",
        details: '{"subscription_status":"grace"}',
      }),
    ).toBe("pause_blocked_subscription");
    expect(pauseErrorCode({ message: "identity_required" })).toBeNull();
  });

  it("parses preflight and ledger visibility", () => {
    const pre = parseVendorPausePreflight({
      can_pause: true,
      block_reason: null,
      open_work: { help: 0, delivery: 0, appointment: 0 },
      khata: { pending_amount: 120, customer_count: 2 },
      upi_claims_pending: 0,
      subscription_status: "trial",
      will_freeze_billing: true,
      pause_min_credit_days: 7,
    });
    expect(pre?.will_freeze_billing).toBe(true);
    expect(shouldShowPauseLedgerNote(pre!)).toBe(true);
    expect(
      shouldShowPauseLedgerNote({
        ...pre!,
        khata: { pending_amount: 0, customer_count: 0 },
        upi_claims_pending: 1,
      }),
    ).toBe(true);
  });

  it("resume toast uses credited vs under-min copy", () => {
    expect(
      resumePauseToast({ credited_days: 7, window_days: 7, qualified: true, reason: "credited" }, 7, en),
    ).toBe("Subscription extended by 7 days");
    expect(
      resumePauseToast(
        { credited_days: 0, window_days: 0, qualified: false, reason: "below_min_credit_days" },
        7,
        en,
      ),
    ).toBe("Paused 0 days, under 7, no extension");
    expect(resumePauseToast(parseResumeOutcome({}), 7, en)).toBe(en.vendor_unpause_saved);
  });

  it("subscription block messages match status", () => {
    expect(subscriptionPauseBlockMessage("grace", en)).toBe(en.vendor_pause_blocked_grace);
    expect(subscriptionPauseBlockMessage("expired", en)).toBe(en.vendor_pause_blocked_expired);
  });
});
