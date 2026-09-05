import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("create_customer_request idempotency wiring", () => {
  it("migration adds key column and RPC param; placement sends persisted UUID", () => {
    const mig = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260905090001_create_customer_request_idempotency.sql",
      ),
      "utf8",
    );
    expect(mig).toContain("client_idempotency_key");
    expect(mig).toContain("p_client_idempotency_key");
    expect(mig).toContain("interval '2 minutes'");

    const place = fs.readFileSync(
      path.join(process.cwd(), "src/lib/executeOrderInsert.ts"),
      "utf8",
    );
    expect(place).toContain("clientIdempotencyKey");
    expect(place).toContain("p_client_idempotency_key: clientIdempotencyKey");
    expect(place).toContain("getOrCreateOrderPlacementIdempotencyKey");

    const parchi = fs.readFileSync(
      path.join(process.cwd(), "src/components/ParchiSheet.tsx"),
      "utf8",
    );
    expect(parchi).toContain("executeOrderInsert");
    expect(parchi).toMatch(/from ["']@\/lib\/executeOrderInsert["']/);
  });
});
