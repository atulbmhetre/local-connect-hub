import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("vendor license capture wiring", () => {
  it("wizard has a conditional optional license step", () => {
    const wiz = readFileSync(resolve("src/components/vendor/VendorRegistrationWizard.tsx"), "utf8");
    expect(wiz).toContain("needsLicenseStep");
    expect(wiz).toContain("reg-license-disclaimer");
    expect(wiz).toContain("vendor_upsert_licenses");
    expect(wiz).toContain("license-docs/");
    expect(wiz).toContain("reg_license_skip");
    expect(wiz).toContain("wizardLicenseFields");
    expect(wiz).not.toContain("LICENSE_FIELD_CATEGORIES_KEY");
  });

  it("Add Business uses the same approved non-generic license gate", () => {
    const sheet = readFileSync(resolve("src/components/vendor/BusinessSetupSheet.tsx"), "utf8");
    expect(sheet).toContain("wizardLicenseFields");
    expect(sheet).toContain("vendor_upsert_licenses");
    expect(sheet).toContain("add-business-license-skip");
  });

  it("migration creates vendor_licenses with menu-style owner RLS and license-docs storage", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830180001_add_vendor_licenses.sql"),
      "utf8",
    );
    expect(mig).toContain("CREATE TABLE IF NOT EXISTS public.vendor_licenses");
    expect(mig).toContain("vendor_licenses_owner");
    expect(mig).toContain("auth_user_phone()");
    expect(mig).toContain("license-docs/%");
    expect(mig).toContain("anon, authenticated");
    expect(mig).toContain("license_field_categories");
    expect(mig).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_vendors_visible_to_customer/);
  });

  it("license classification migration stores unapproved proposals and admin RPCs", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830190001_category_license_classification.sql"),
      "utf8",
    );
    expect(mig).toContain("license_type");
    expect(mig).toContain("license_confidence_score");
    expect(mig).toContain("license_reasoning");
    expect(mig).toContain("license_review_status");
    expect(mig).toContain("admin_list_pending_category_licenses");
    expect(mig).toContain("admin_approve_category_license");
    expect(mig).toContain("admin_reject_category_license");
    expect(mig).toContain("Never auto-approved");
    expect(mig).toContain("SET license_review_status = 'approved'");
    expect(mig).not.toMatch(/license_review_status\s+text\s+NOT NULL\s+DEFAULT\s+'approved'/);
  });

  it("owner-scopes license-docs storage and guards license_review_status", () => {
    const mig = readFileSync(
      resolve("supabase/migrations/20260830200001_license_docs_owner_scope_and_review_guard.sql"),
      "utf8",
    );
    expect(mig).toContain("storage_license_docs_owned");
    expect(mig).toContain("license-docs/");
    expect(mig).toContain("auth_user_phone()");
    expect(mig).toContain("name NOT LIKE 'license-docs/%'");
    expect(mig).toContain("NEW.license_review_status IS DISTINCT FROM OLD.license_review_status");
    expect(mig).toContain("direct admin column write blocked on categories");
  });

  it("admin settings has a pending-license review queue and backfill", () => {
    const settings = readFileSync(resolve("src/pages/Settings.tsx"), "utf8");
    expect(settings).toContain("admin_pendingLicenses");
    expect(settings).toContain("admin_list_pending_category_licenses");
    expect(settings).toContain("admin_approve_category_license");
    expect(settings).toContain("backfill_licenses");
    expect(settings).toContain("admin-license-backfill");
  });
});

