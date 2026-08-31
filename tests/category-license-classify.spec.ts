/**
 * Category license classification: columns, pending gate, admin review UI.
 * Does not approve seeded catalog licenses.
 */
import { test, expect } from "@playwright/test";
import { loginAsAdminViaSession } from "./helpers/browser-setup";
import { supabaseAdmin } from "./helpers/setup";
import { wizardLicenseFields } from "../src/lib/vendorLicenses";

const T = Date.now();
const LABEL = `LicClass ${T}`;
let createdCategoryId: string | null = null;

test.setTimeout(90_000);

test.afterAll(async () => {
  if (createdCategoryId) {
    await supabaseAdmin.from("categories").delete().eq("id", createdCategoryId);
  }
});

test("LIC-01 — pending license is listed, unused until approve, category stays live", async ({
  page,
}) => {
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("categories")
    .insert({
      label: LABEL,
      emoji: "🧪",
      service_mode: "help",
      is_active: true,
      pending_review: false,
      status: "active",
      sort_order: 99,
      license_type: "Drug License",
      license_confidence_score: 0.92,
      license_reasoning: "Pharmacy-like test category",
      license_review_status: "pending_review",
    })
    .select("id, is_active, license_review_status")
    .single();
  expect(insErr, insErr?.message).toBeNull();
  createdCategoryId = inserted!.id;

  const unused = wizardLicenseFields([
    {
      id: inserted!.id,
      label: LABEL,
      license_type: "Drug License",
      license_review_status: "pending_review",
    },
  ]);
  expect(unused.map((f) => f.licenseType)).toEqual([]);

  await loginAsAdminViaSession(page, `lic_admin_${T}`);
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15000 });

  const pendingBtn = page.getByRole("button", { name: /Pending Licenses/i });
  await expect(pendingBtn).toBeVisible({ timeout: 15000 });
  await pendingBtn.click();
  const card = page.getByTestId(`pending-license-card-${inserted!.id}`);
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card.getByText("Drug License")).toBeVisible();
  await expect(card.getByText(/92%/)).toBeVisible();

  await card.getByRole("button", { name: /Approve license/i }).click();
  await expect(card).toHaveCount(0, { timeout: 15000 });

  const { data: after } = await supabaseAdmin
    .from("categories")
    .select("is_active, status, license_review_status, license_type")
    .eq("id", inserted!.id)
    .single();
  expect(after?.is_active).toBe(true);
  expect(after?.status).toBe("active");
  expect(after?.license_review_status).toBe("approved");
  expect(after?.license_type).toBe("Drug License");

  const used = wizardLicenseFields([
    {
      id: inserted!.id,
      label: LABEL,
      license_type: after!.license_type,
      license_review_status: after!.license_review_status,
    },
  ]);
  expect(used.map((f) => f.licenseType)).toEqual(["drug_license"]);
});
