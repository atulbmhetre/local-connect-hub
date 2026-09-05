import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("order accept/fulfill status gates wiring", () => {
  const acceptMig = readFileSync(
    resolve(
      "supabase/migrations/20260905260001_order_accept_fulfill_status_gates.sql",
    ),
    "utf8",
  );
  const fulfilMig = readFileSync(
    resolve(
      "supabase/migrations/20260905270001_vendor_fulfil_accepted_gate_drop_settle.sql",
    ),
    "utf8",
  );
  const incoming = readFileSync(
    resolve("src/components/IncomingOrdersSection.tsx"),
    "utf8",
  );

  it("accept rejects non-sent/seen p_from_status and requires actual sent|seen", () => {
    expect(acceptMig).toContain("invalid_from_status");
    expect(acceptMig).toContain("r.status IN ('sent', 'seen')");
    expect(acceptMig).toContain("vendor_accept_order");
  });

  it("live fulfil path is vendor_fulfil_order with accepted gate", () => {
    expect(incoming).toContain('rpc("vendor_fulfil_order"');
    expect(incoming).not.toContain("vendor_settle_order");
    expect(fulfilMig).toContain("CREATE OR REPLACE FUNCTION public.vendor_fulfil_order");
    expect(fulfilMig).toContain("r.status = 'accepted'");
    expect(fulfilMig).toContain("not_accepted");
    expect(fulfilMig).toContain("SET status = 'fulfilled'");
  });

  it("drops mistaken vendor_settle_order", () => {
    expect(fulfilMig).toContain(
      "DROP FUNCTION IF EXISTS public.vendor_settle_order(uuid, uuid, text)",
    );
  });
});
