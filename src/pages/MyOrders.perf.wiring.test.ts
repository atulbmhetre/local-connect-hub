import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("My Orders list performance wiring", () => {
  const page = readFileSync(resolve("src/pages/MyOrders.tsx"), "utf8");
  const mig = readFileSync(
    resolve("supabase/migrations/20260906120001_get_my_orders_pagination.sql"),
    "utf8",
  );

  it("bounds get_my_orders with p_limit and a matching count RPC", () => {
    expect(mig).toMatch(/p_limit integer DEFAULT 50/);
    expect(mig).toMatch(/LIMIT v_limit/);
    expect(mig).toContain("get_my_orders_count");
    expect(page).toContain("p_limit");
    expect(page).toContain("get_my_orders_count");
    expect(page).toContain("MY_ORDERS_PAGE_SIZE");
    expect(page).toContain("my-orders-load-more");
  });

  it("skips the 30s poll when Realtime recently patched, and does not silent-refetch on the channel", () => {
    expect(page).toContain("shouldSkipBackupPoll");
    expect(page).toContain("lastRealtimeAtRef");
    expect(page).not.toMatch(/setInterval\(\(\) => void load\(\{ silent: true \}\), 30_000\)/);
    expect(page).toMatch(/event:\s*"INSERT"/);
  });

  it("rebuilds the vendor-location channel only when the sorted vendor-id key changes", () => {
    expect(page).toContain("acceptedHelpVendorIdsKey");
    expect(page).toContain("stableSortedKey");
    expect(page).toMatch(/\[acceptedHelpVendorIdsKey, applyVendorLocationUpdate\]/);
  });

  it("virtualizes the order list", () => {
    expect(page).toContain("VirtualizedWindowList");
    expect(page).not.toMatch(/filteredRows\.map\(\(r\) => \(/);
  });
});
