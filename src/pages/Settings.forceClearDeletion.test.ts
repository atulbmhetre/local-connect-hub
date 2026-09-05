import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Admin force-clear deletion (Settings vendor row)", () => {
  const src = readFileSync(
    resolve(__dirname, "../components/settings/AdminConsole.tsx"),
    "utf8",
  );

  it("sits on the same vendor row as Ban/Unban and is gated on deletion_requested_at", () => {
    const banBtn = src.indexOf("setVendorBanDialog({ open: true, vendor: v })");
    const unbanBtn = src.indexOf("void unbanVendor(v.id)");
    const clearBtn = src.indexOf('data-testid="admin-force-clear-deletion"');
    expect(banBtn).toBeGreaterThan(-1);
    expect(unbanBtn).toBeGreaterThan(banBtn);
    expect(clearBtn).toBeGreaterThan(unbanBtn);
    expect(src).toContain("{v.deletion_requested_at ? (");
    expect(src).toContain('rpc("admin_force_clear_deletion"');
  });

  it("requires a reason before confirm is enabled, matching Ban weight", () => {
    expect(src).toContain("Force-clear scheduled deletion?");
    expect(src).toContain("!vendorClearDeletionReason.trim()");
    expect(src).toContain('data-testid="admin-force-clear-deletion-reason"');
    expect(src).toContain('"force_clear_deletion"');
    expect(src).toContain("logAdminAction");
  });
});
