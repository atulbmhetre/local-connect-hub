import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("state machine high gaps wiring", () => {
  const mig = readFileSync(
    resolve("supabase/migrations/20260905280001_state_machine_high_gaps.sql"),
    "utf8",
  );

  it("Help expiry covers sent and seen", () => {
    expect(mig).toMatch(
      /service_mode = 'help'[\s\S]{0,80}r\.status IN \('sent', 'seen'\)/,
    );
  });

  it("historical admin resolve was shipped then replaced by dismiss-disputed fix", () => {
    // 20260905280001 introduced admin_resolve; 20260905300001 drops it.
    expect(mig).toContain("admin_resolve_disputed_upi_payment");
    const replacement = readFileSync(
      resolve(
        "supabase/migrations/20260905300001_dismiss_allows_disputed_drop_admin_resolve.sql",
      ),
      "utf8",
    );
    expect(replacement).toContain(
      "DROP FUNCTION IF EXISTS public.admin_resolve_disputed_upi_payment",
    );
  });

  it("vendor_cancel_order requires sent|seen|accepted", () => {
    expect(mig).toContain("vendor_cancel_order");
    expect(mig).toContain("r.status IN ('sent', 'seen', 'accepted')");
    expect(mig).toContain("invalid_from_status");
  });

  it("spawn pauses recurring on permanent spawn failures", () => {
    expect(mig).toContain("spawn_due_recurring_orders");
    expect(mig).toContain("vendor_banned");
    expect(mig).toContain("vendor_deletion_scheduled");
    expect(mig).toContain("status = 'paused'");
  });
});
