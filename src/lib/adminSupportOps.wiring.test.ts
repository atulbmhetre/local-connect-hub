import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin support tickets + customer lookup wiring", () => {
  const mig = readFileSync(
    resolve("supabase/migrations/20260906160001_admin_support_and_customer_lookup.sql"),
    "utf8",
  );
  const adminConsole = readFileSync(
    resolve("src/components/settings/AdminConsole.tsx"),
    "utf8",
  );
  const ops = readFileSync(resolve("src/lib/adminSupportOps.ts"), "utf8");

  it("migration adds resolved_at, admin SELECT policy, and gated RPCs", () => {
    expect(mig).toContain("ADD COLUMN IF NOT EXISTS resolved_at timestamptz");
    expect(mig).toContain("support_messages_admin_select");
    expect(mig).toContain("USING (public.is_admin_session())");
    expect(mig).toContain("CREATE OR REPLACE FUNCTION public.admin_list_support_messages");
    expect(mig).toContain("CREATE OR REPLACE FUNCTION public.admin_resolve_support_message");
    expect(mig).toContain("CREATE OR REPLACE FUNCTION public.admin_lookup_customer");
    expect(mig).toContain("FROM public.payment_dispute_events");
    expect(mig).toContain("FROM public.khata_ledger");
    expect(mig).toContain("RAISE EXCEPTION 'unauthorized'");
    expect(mig).toContain("GRANT EXECUTE ON FUNCTION public.admin_list_support_messages(boolean) TO authenticated");
    expect(mig).toContain("REVOKE ALL ON FUNCTION public.admin_lookup_customer(text) FROM anon");
  });

  it("AdminConsole mounts support + lookup panels on the RPC helpers", () => {
    expect(ops).toContain('rpc("admin_list_support_messages"');
    expect(ops).toContain('rpc("admin_resolve_support_message"');
    expect(ops).toContain('rpc("admin_lookup_customer"');
    expect(adminConsole).toContain("loadAdminSupportMessages");
    expect(adminConsole).toContain("resolveAdminSupportMessage");
    expect(adminConsole).toContain("lookupAdminCustomer");
    expect(adminConsole).toContain('testId="admin-support-tickets"');
    expect(adminConsole).toContain('testId="admin-customer-lookup"');
    expect(adminConsole).toContain('data-testid="admin-customer-lookup-input"');
    expect(adminConsole).toContain('data-testid="admin-support-resolve"');
  });
});
