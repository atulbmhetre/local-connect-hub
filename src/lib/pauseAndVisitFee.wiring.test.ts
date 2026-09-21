import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("pause + visit fee wiring (impact scope)", () => {
  it("My Business editor has pause toggle and inspection fee field", () => {
    const src = readFileSync(resolve("src/components/settings/VendorMyBusiness.tsx"), "utf8");
    expect(src).toContain("vendor_pause_business");
    expect(src).toContain("is_paused");
    expect(src).toContain("inspection_fee");
    expect(src).toContain("vendor_pause_preflight");
    expect(src).toContain("vendor_update_category_profile");
  });

  it("Radar card chip and Parchi sticky footer surface the fee", () => {
    const card = readFileSync(resolve("src/components/RadarVendorCard.tsx"), "utf8");
    const parchi = readFileSync(resolve("src/components/ParchiSheet.tsx"), "utf8");
    expect(card).toContain("radar-inspection-fee-chip");
    expect(parchi).toContain("parchi-inspection-fee");
    expect(parchi).toContain("parchi-submit-btn");
    const feeIdx = parchi.indexOf("parchi-inspection-fee");
    const sendIdx = parchi.indexOf("parchi-submit-btn");
    expect(feeIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(feeIdx);
  });

  it("radar RPC and booking gate exclude paused businesses", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830120001_vendor_category_pause_and_inspection_fee.sql"),
      "utf8",
    );
    expect(mig).toContain("vc.is_paused");
    expect(mig).toContain("get_radar_category_mode_matches");
    expect(mig).toContain("create_customer_request");
    expect(mig).toContain("vendors_public_discoverable_read");
    expect(mig).toContain("vendor_categories_public_read");
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
    const rlsFix = readFileSync(
      resolve("supabase/migrations/20260830140001_fix_pause_rls_recursion.sql"),
      "utf8",
    );
    expect(rlsFix).toContain("vendor_has_discoverable_business");
    expect(rlsFix).toContain("SECURITY DEFINER");
    expect(rlsFix).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
  });

  it("pause start is trial|active only; PATCH uses the same helper; preflight is not anon", () => {
    const sub = readFileSync(
      resolve("supabase/migrations/20260922010001_pause_only_trial_active.sql"),
      "utf8",
    );
    expect(sub).toContain("_vendor_assert_can_start_pause");
    expect(sub).toContain("IS DISTINCT FROM 'trial' AND v_sub IS DISTINCT FROM 'active'");
    expect(sub).not.toMatch(/v_sub IN \('grace', 'expired'\)/);
    const patch = readFileSync(
      resolve("supabase/migrations/20260922020001_pause_start_before_update_gate.sql"),
      "utf8",
    );
    expect(patch).toContain("BEFORE UPDATE OF is_paused");
    expect(patch).toContain("_vendor_assert_can_start_pause");
    expect(patch).toContain("vendor_categories_pause_block_trg");
    const sess = readFileSync(
      resolve("supabase/migrations/20260922030001_vendor_pause_preflight_session.sql"),
      "utf8",
    );
    expect(sess).toContain("_assert_vendor_session_matches");
    expect(sess).toContain("REVOKE ALL ON FUNCTION public.vendor_pause_preflight(uuid, uuid) FROM PUBLIC, anon");
    expect(sess).toMatch(/GRANT EXECUTE ON FUNCTION public\.vendor_pause_preflight\(uuid, uuid\)\s+TO authenticated, service_role/);
  });
});
