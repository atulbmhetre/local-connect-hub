/**
 * Mode Confidence Review live smoke (TEST only):
 * Seed >=3 vendors on a non-default mode → pending review → admin UI
 * with counts + vendor list → Dismiss and Update default.
 *
 * Dismissed re-flag policy: proposed count must reach dismissed_at + 2.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/mode-confidence-review-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import {
  ensureTestAdminUser,
  loginAsAdminViaSession,
} from "./helpers/browser-setup";
import {
  deleteVendorRegistrationArtifacts,
  seedVendorCategory,
  supabaseAdmin,
} from "./helpers/setup";
import { loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const SESSION = `MCR_${Date.now()}`;
const observations: string[] = [];
const vendorIds: string[] = [];
const categoryIds: string[] = [];
const reviewIds: string[] = [];

async function ensureCategory(label: string, serviceMode: "help" | "delivery" | "appointment") {
  const { data: existing } = await supabaseAdmin
    .from("categories")
    .select("id, label, service_mode, emoji")
    .eq("label", label)
    .maybeSingle();
  if (existing?.id) {
    await supabaseAdmin
      .from("categories")
      .update({
        is_active: true,
        status: "active",
        service_mode: serviceMode,
        pending_review: false,
      })
      .eq("id", existing.id);
    categoryIds.push(existing.id);
    return { ...existing, service_mode: serviceMode };
  }
  const { data, error } = await supabaseAdmin
    .from("categories")
    .insert({
      label,
      emoji: "🧪",
      service_mode: serviceMode,
      is_active: true,
      status: "active",
      sort_order: 998,
      pending_review: false,
    })
    .select("id, label, service_mode, emoji")
    .single();
  if (error) throw error;
  categoryIds.push(data!.id);
  return data!;
}

async function clearPendingReviews(categoryId: string) {
  await supabaseAdmin.from("category_mode_reviews").delete().eq("category_id", categoryId);
}

async function seedNonDefaultVendors(
  category: { id: string; label: string; service_mode: string },
  nonDefaultMode: "help" | "delivery" | "appointment",
  count: number,
  tag: string,
) {
  for (let i = 0; i < count; i++) {
    const phone = `9918${Date.now().toString().slice(-5)}${i}`;
    const { data: vendor, error } = await supabaseAdmin
      .from("vendors")
      .insert({
        name: `MCR ${tag} ${i}`,
        shop_name: `!MCR-${tag}-${i}-${SESSION}`,
        phone,
        category: category.label ?? "Test",
        service_mode: nonDefaultMode,
        is_active: true,
        is_banned: false,
        photo_selfie: "https://example.com/mcr-selfie.jpg",
        shop_photo_url: "https://example.com/mcr-shop.jpg",
        latitude: 18.5204,
        longitude: 73.8567,
      })
      .select("id, shop_name, phone")
      .single();
    if (error) throw error;
    vendorIds.push(vendor!.id);
    await seedVendorCategory(vendor!.id, category, {
      modes: [nonDefaultMode],
      is_manual_verified: true,
    });
  }
}

test.afterAll(async () => {
  for (const id of reviewIds) {
    await supabaseAdmin.from("category_mode_reviews").delete().eq("id", id);
  }
  for (const id of categoryIds) {
    await supabaseAdmin.from("category_mode_reviews").delete().eq("category_id", id);
  }
  for (const id of vendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  // Leave smoke categories in place (inactive) so labels stay unique if re-run mid-flight
  for (const id of categoryIds) {
    await supabaseAdmin
      .from("categories")
      .update({ is_active: false, status: "inactive" })
      .eq("id", id);
  }
  console.log("MCR_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("mode confidence: flag at 3, admin UI, dismiss + confirm", async ({ page }) => {
  await ensureTestAdminUser();

  const dismissCat = await ensureCategory(`!MCR Dismiss ${SESSION}`, "help");
  const confirmCat = await ensureCategory(`!MCR Confirm ${SESSION}`, "help");
  await clearPendingReviews(dismissCat.id);
  await clearPendingReviews(confirmCat.id);

  observations.push(`dismissCat=${dismissCat.id} default=help`);
  observations.push(`confirmCat=${confirmCat.id} default=help`);

  // --- Dismiss path ---
  await seedNonDefaultVendors(dismissCat, "appointment", 3, "D");
  const { error: flagDismissErr } = await supabaseAdmin.rpc("maybe_flag_category_mode_reviews", {
    p_category_ids: [dismissCat.id],
  });
  expect(flagDismissErr).toBeNull();

  const { data: dismissPending, error: dPendErr } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("*")
    .eq("category_id", dismissCat.id)
    .eq("status", "pending_review")
    .maybeSingle();
  expect(dPendErr).toBeNull();
  expect(dismissPending).toBeTruthy();
  expect(dismissPending!.proposed_mode).toBe("appointment");
  expect(dismissPending!.proposed_mode_vendor_count).toBeGreaterThanOrEqual(3);
  expect(dismissPending!.current_default_mode).toBe("help");
  reviewIds.push(dismissPending!.id);
  observations.push(
    `dismiss pending id=${dismissPending!.id} proposed_count=${dismissPending!.proposed_mode_vendor_count}`,
  );

  // No duplicate while pending
  await supabaseAdmin.rpc("maybe_flag_category_mode_reviews", {
    p_category_ids: [dismissCat.id],
  });
  const { count: pendingCount } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("id", { count: "exact", head: true })
    .eq("category_id", dismissCat.id)
    .eq("status", "pending_review");
  expect(pendingCount).toBe(1);
  observations.push("no duplicate pending while already pending_review");

  // --- Confirm path seed ---
  await seedNonDefaultVendors(confirmCat, "appointment", 3, "C");
  const { error: flagConfirmErr } = await supabaseAdmin.rpc("maybe_flag_category_mode_reviews", {
    p_category_ids: [confirmCat.id],
  });
  expect(flagConfirmErr).toBeNull();
  const { data: confirmPending } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("*")
    .eq("category_id", confirmCat.id)
    .eq("status", "pending_review")
    .maybeSingle();
  expect(confirmPending).toBeTruthy();
  reviewIds.push(confirmPending!.id);
  observations.push(`confirm pending id=${confirmPending!.id}`);

  // --- Admin UI ---
  await loginAsAdminViaSession(page, `mcr_admin_${SESSION}`);
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Mode Confidence Review|मोड विश्वास समीक्षा/i }).click();

  const dismissCard = page.getByTestId(`mode-confidence-card-${dismissPending!.id}`);
  await expect(dismissCard).toBeVisible({ timeout: 20_000 });
  await expect(dismissCard).toContainText(dismissCat.label);
  await expect(dismissCard).toContainText(String(dismissPending!.proposed_mode_vendor_count));

  await dismissCard.getByTestId(`mode-confidence-view-proposed-${dismissPending!.id}`).click();
  const vendorList = page.getByTestId(`mode-confidence-vendor-list-${dismissPending!.id}`);
  await expect(vendorList).toBeVisible({ timeout: 15_000 });
  await expect(vendorList.getByText(/!MCR-D-0-/)).toBeVisible();
  await expect(vendorList.getByText(/9918/).first()).toBeVisible();
  observations.push("admin UI shows review + real vendor name/phone");

  await dismissCard.getByTestId(`mode-confidence-dismiss-${dismissPending!.id}`).click();
  await expect(dismissCard).toBeHidden({ timeout: 15_000 });

  const { data: dismissedRow } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("status, dismissed_at_proposed_count, reviewed_at")
    .eq("id", dismissPending!.id)
    .single();
  expect(dismissedRow!.status).toBe("dismissed");
  expect(dismissedRow!.dismissed_at_proposed_count).toBe(
    dismissPending!.proposed_mode_vendor_count,
  );
  observations.push(
    `dismissed floor=${dismissedRow!.dismissed_at_proposed_count}; re-flag needs +2`,
  );

  // Same count must NOT re-flag
  await supabaseAdmin.rpc("maybe_flag_category_mode_reviews", {
    p_category_ids: [dismissCat.id],
  });
  const { data: noReflag } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("id")
    .eq("category_id", dismissCat.id)
    .eq("status", "pending_review")
    .maybeSingle();
  expect(noReflag).toBeNull();
  observations.push("dismissed does not re-flag at same count");

  // --- Confirm Update default ---
  const confirmCard = page.getByTestId(`mode-confidence-card-${confirmPending!.id}`);
  await expect(confirmCard).toBeVisible();
  await confirmCard.getByTestId(`mode-confidence-confirm-${confirmPending!.id}`).click();
  await expect(confirmCard).toBeHidden({ timeout: 15_000 });

  const { data: confirmedRow } = await supabaseAdmin
    .from("category_mode_reviews")
    .select("status, reviewed_at")
    .eq("id", confirmPending!.id)
    .single();
  expect(confirmedRow!.status).toBe("confirmed");

  const { data: updatedCat } = await supabaseAdmin
    .from("categories")
    .select("service_mode")
    .eq("id", confirmCat.id)
    .single();
  expect(updatedCat!.service_mode).toBe("appointment");
  observations.push("confirm updated categories.service_mode → appointment");

  // Restore catalog default for the confirm category
  await supabaseAdmin
    .from("categories")
    .update({ service_mode: "help" })
    .eq("id", confirmCat.id);
});
