import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("order placement idempotency wiring", () => {
  it("one-shot and recurring paths persist and send client idempotency key", () => {
    const place = fs.readFileSync(
      path.join(process.cwd(), "src/lib/executeOrderInsert.ts"),
      "utf8",
    );
    expect(place).toContain("getOrCreateOrderPlacementIdempotencyKey");
    expect(place).toContain("clearOrderPlacementIdempotencyKey");
    expect(place).toContain("p_client_idempotency_key: clientIdempotencyKey");
    expect(place).toContain('supabase.rpc("create_recurring_order"');
    expect(place).toContain('supabase.rpc("create_customer_request", orderPayload)');
    // Key must not be minted fresh each call via bare safeRandomUUID in this module.
    expect(place).not.toMatch(/safeRandomUUID\s*\(/);

    const parchi = fs.readFileSync(
      path.join(process.cwd(), "src/components/ParchiSheet.tsx"),
      "utf8",
    );
    expect(parchi).toContain("clearOrderPlacementIdempotencyKey");

    const recurringMig = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260905220001_create_recurring_order_idempotency.sql",
      ),
      "utf8",
    );
    expect(recurringMig).toContain("recurring_orders_client_idempotency_key_uidx");
    expect(recurringMig).toContain("p_client_idempotency_key");
    expect(recurringMig).toContain("interval '2 minutes'");
    expect(recurringMig).toMatch(/create_customer_request\([\s\S]*v_idem/);
  });
});
