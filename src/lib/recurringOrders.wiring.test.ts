import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("recurring orders wiring", () => {
  it("Parchi offers recurrence for Delivery/Scheduled, not Help", () => {
    const parchi = readFileSync(resolve("src/components/ParchiSheet.tsx"), "utf8");
    expect(parchi).toContain("parchi-recurrence");
    expect(parchi).toContain("create_recurring_order");
    expect(parchi).toContain("showRecurrence");
    expect(parchi).toMatch(/isHelpMode/);
    expect(parchi).toContain('deliverySlot !== "asap"');
    expect(parchi).toContain("appointmentTiming === \"scheduled\"");
  });

  it("My Orders surfaces pause/resume/stop on the arrangement, not buried in a single request", () => {
    const orders = readFileSync(resolve("src/pages/MyOrders.tsx"), "utf8");
    expect(orders).toContain("list_my_recurring_orders");
    expect(orders).toContain("customer_set_recurring_order_status");
    expect(orders).toContain("myOrders_recurringHeading");
    expect(orders).toContain("recurring-order-pause-");
    expect(orders).toContain("recurring-order-stop-");
  });

  it("parent table spawns ordinary requests; khata and history RPCs are untouched", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830170001_recurring_orders.sql"),
      "utf8",
    );
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS public.recurring_orders");
    expect(mig).toContain("spawn_due_recurring_orders");
    expect(mig).toContain("create_recurring_order");
    expect(mig).toContain("recurrence_mode_not_allowed");
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_my_orders/);
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.create_customer_request/);
    expect(mig).not.toMatch(/khata_ledger/);
    expect(mig).not.toMatch(/khata_transactions/);
  });
});
