/**
 * Live Phase 3 Pending Categories smoke (TEST only).
 * Seeds three pending suggestions, drives Settings admin UI for
 * Approve as new / Merge as alias / Reject, asserts DB + screenshots notes.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase3-pending-categories-smoke.spec.ts
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  ensureTestAdminUser,
  loginAsAdminViaSession,
} from "./helpers/browser-setup";
import {
  getAnonKey,
  getServiceRoleClient,
  getSupabaseUrl,
  loadTestEnv,
} from "./helpers/testEnv";

loadTestEnv();

const APP_URL = process.env.APP_URL?.trim() || "http://127.0.0.1:8081";
const supabaseAdmin = getServiceRoleClient();
const SESSION = `P3SMOKE_${Date.now()}`;
const LABEL_APPROVE = `Milkman Approve ${SESSION}`;
const LABEL_MERGE = `Milkman Merge ${SESSION}`;
const LABEL_REJECT = `Milkman Reject ${SESSION}`;
const LABEL_NOAUTO = `Milkman NoAuto ${SESSION}`;

const createdVendorIds: string[] = [];
const createdCategoryIds: string[] = [];
const observations: string[] = [];

async function seedVendor(tag: string) {
  const phone = `99${String(Date.now()).slice(-8)}`;
  const { data: cat } = await supabaseAdmin
    .from("categories")
    .select("id, label, service_mode")
    .eq("is_active", true)
    .eq("label", "Mechanic")
    .maybeSingle();
  expect(cat?.id).toBeTruthy();

  const { data: v, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `P3 ${tag}`,
      shop_name: `!P3-${tag}-${SESSION}`,
      phone,
      category: cat!.label,
      service_mode: cat!.service_mode,
      vendor_type: "shop",
      base_type: "shop",
      serves_at_vendor_place: true,
      serves_at_customer_place: false,
      latitude: 18.52,
      longitude: 73.85,
      is_active: true,
      profile_status: "complete",
      service_radius_km: 10,
      upi_id: `${tag}@upi`,
      discoverable: true,
    })
    .select("id, phone")
    .single();
  expect(error).toBeNull();
  createdVendorIds.push(v!.id);
  return v!;
}

async function seedPending(
  vendorId: string,
  label: string,
  extras: {
    aliases?: string[];
    overlap?: string | null;
    overlapReason?: string | null;
  } = {},
) {
  const { data, error } = await supabaseAdmin
    .from("categories")
    .insert({
      label,
      emoji: "🥛",
      service_mode: "delivery",
      is_active: false,
      pending_review: true,
      status: "pending_review",
      suggested_by_vendor_id: vendorId,
      ai_confidence: "high",
      ai_confidence_score: 0.91,
      ai_reasoning: `Synthetic pending for ${label}`,
      ai_service_mode_reasoning: "Goods brought to the customer (delivery).",
      proposed_aliases: extras.aliases ?? ["doodhwala", "milk delivery", "fresh milk"],
      overlap_category_label: extras.overlap ?? "Dairy",
      overlap_reasoning:
        extras.overlapReason ?? "Same real-world milk / dairy business type as Dairy.",
      suggestion_count: 1,
      sort_order: 99,
    })
    .select("id, label")
    .single();
  expect(error).toBeNull();
  createdCategoryIds.push(data!.id);
  return data!;
}

function pendingCard(page: import("@playwright/test").Page, label: string) {
  return page
    .locator(".rounded-2xl.border.border-border.p-3")
    .filter({ has: page.getByText(label, { exact: true }) });
}

test.beforeAll(async () => {
  await ensureTestAdminUser();
});

test.afterAll(async () => {
  console.log("\n==== PHASE3 LIVE UI OBSERVATIONS ====");
  for (const line of observations) console.log(line);
  console.log("==== END OBSERVATIONS ====\n");

  if (createdCategoryIds.length) {
    await supabaseAdmin
      .from("category_search_terms")
      .delete()
      .in("category_id", createdCategoryIds);
    // Also clean aliases merged onto Dairy that contain SESSION
    await supabaseAdmin
      .from("category_search_terms")
      .delete()
      .ilike("term", `%${SESSION.toLowerCase()}%`);
    await supabaseAdmin.from("categories").delete().in("id", createdCategoryIds);
  }
  await supabaseAdmin.from("categories").delete().ilike("label", `%${SESSION}%`);
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
});

test("Phase 3 live: Approve / Merge / Reject + no auto-approve", async ({ page }) => {
  const vApprove = await seedVendor("approve");
  const vMerge = await seedVendor("merge");
  const vReject = await seedVendor("reject");
  const vNoAuto1 = await seedVendor("noauto1");
  const vNoAuto2 = await seedVendor("noauto2");

  const approveCat = await seedPending(vApprove.id, LABEL_APPROVE, {
    aliases: ["doodhwala approve", "milkman approve"],
  });
  const mergeCat = await seedPending(vMerge.id, LABEL_MERGE, {
    aliases: ["doodhwala merge", "milkman merge"],
    overlap: "Dairy",
  });
  const rejectCat = await seedPending(vReject.id, LABEL_REJECT, {
    aliases: ["doodhwala reject"],
  });

  // --- Double suggestion no-auto-approve (two vendors, same label) ---
  // Mirrors deployed upsertPendingNewCategory: increment count + refresh AI fields only.
  const noAuto = await seedPending(vNoAuto1.id, LABEL_NOAUTO, {
    aliases: ["noauto doodh"],
  });
  await supabaseAdmin
    .from("categories")
    .update({
      suggestion_count: 2,
      suggested_by_vendor_id: vNoAuto2.id,
      ai_reasoning: "Second independent vendor suggested the same label",
      ai_service_mode_reasoning: "Still delivery — goods to customer",
      proposed_aliases: ["noauto doodh", "noauto milkman"],
      // Phase 3: never flip active here
    })
    .eq("id", noAuto.id);
  const { data: noAutoAfterSecond } = await supabaseAdmin
    .from("categories")
    .select("id, label, status, is_active, pending_review, suggestion_count")
    .eq("id", noAuto.id)
    .single();
  observations.push(
    `no-auto after 2nd vendor suggestion (DB mirror of edge upsert): ${JSON.stringify(noAutoAfterSecond)}`,
  );
  expect(noAutoAfterSecond?.is_active).toBe(false);
  expect(noAutoAfterSecond?.pending_review).toBe(true);
  expect(noAutoAfterSecond?.status).toBe("pending_review");
  expect(noAutoAfterSecond?.suggestion_count).toBe(2);

  // Also poke live edge function twice (observational — AI may map to existing)
  const anon = createClient(getSupabaseUrl(), getAnonKey());
  const desc = `Brand-new neighbourhood trade called ${LABEL_NOAUTO} Extra: doorstep fresh cow milk bottles only.`;
  const invoke = async (vendorId: string) => {
    const { data, error } = await anon.functions.invoke("suggest-category", {
      body: {
        description: desc,
        vendor_id: vendorId,
        create_pending: true,
        device_id: `p3smoke_${SESSION}_${vendorId.slice(0, 6)}`,
      },
    });
    return { data, error };
  };
  const first = await invoke(vNoAuto1.id);
  observations.push(
    `no-auto edge#1 error=${first.error?.message ?? "null"} data=${JSON.stringify(first.data)}`,
  );
  await page.waitForTimeout(1200);
  const second = await invoke(vNoAuto2.id);
  observations.push(
    `no-auto edge#2 error=${second.error?.message ?? "null"} data=${JSON.stringify(second.data)}`,
  );
  for (const inv of [first, second]) {
    const id = (inv.data as { category_id?: string } | null)?.category_id;
    const outcome = (inv.data as { outcome?: string } | null)?.outcome;
    if (id && !createdCategoryIds.includes(id)) createdCategoryIds.push(id);
    if (outcome === "new_auto_approved") {
      throw new Error("Edge returned new_auto_approved — Phase 3 regression");
    }
  }

  // Login admin UI
  await loginAsAdminViaSession(page, `p3_admin_${SESSION}`);
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15000 });
  observations.push("UI: admin-panel visible after login");

  const pendingBtn = page.getByRole("button", {
    name: /Pending Categories/i,
  });
  await expect(pendingBtn).toBeVisible({ timeout: 10000 });
  await pendingBtn.click();
  observations.push(`UI: opened Pending Categories (${await pendingBtn.innerText()})`);

  // (a) Approve as new
  const approveCard = pendingCard(page, LABEL_APPROVE);
  await expect(approveCard).toBeVisible({ timeout: 10000 });
  await expect(approveCard.getByText(/Mode reason/i)).toBeVisible();
  await expect(approveCard.getByText(/Proposed aliases/i)).toBeVisible();
  await expect(approveCard.getByText(/Possible overlap/i)).toBeVisible();
  observations.push(
    `UI Approve card text snippet: ${(await approveCard.innerText()).replace(/\s+/g, " ").slice(0, 280)}`,
  );
  await approveCard.getByRole("button", { name: /Approve as new/i }).click();
  await page.waitForTimeout(2000);
  await expect(pendingCard(page, LABEL_APPROVE)).toHaveCount(0, { timeout: 10000 });
  observations.push("UI: Approve as new — card disappeared from pending list");

  const { data: approved } = await supabaseAdmin
    .from("categories")
    .select("is_active, pending_review, status")
    .eq("id", approveCat.id)
    .single();
  observations.push(`DB after approve: ${JSON.stringify(approved)}`);
  expect(approved?.is_active).toBe(true);
  expect(approved?.status).toBe("active");

  const { data: approveTerms } = await supabaseAdmin
    .from("category_search_terms")
    .select("term, source, status")
    .eq("category_id", approveCat.id)
    .eq("status", "active");
  observations.push(`DB aliases after approve: ${JSON.stringify(approveTerms)}`);
  expect((approveTerms ?? []).map((t) => t.term).sort()).toEqual(
    ["doodhwala approve", "milkman approve"].sort(),
  );

  // (b) Merge as alias → Dairy
  const mergeCard = pendingCard(page, LABEL_MERGE);
  await expect(mergeCard).toBeVisible({ timeout: 10000 });
  observations.push(
    `UI Merge card snippet: ${(await mergeCard.innerText()).replace(/\s+/g, " ").slice(0, 280)}`,
  );
  await mergeCard.getByRole("button", { name: /Merge as alias/i }).click();
  await expect(page.getByText(/Merge into existing category/i)).toBeVisible({
    timeout: 8000,
  });
  const select = page.locator("select");
  await expect(select).toBeVisible();
  // Pick Dairy by label in options
  const options = await select.locator("option").allTextContents();
  const dairyOpt = options.find((o) => /Dairy/i.test(o));
  expect(dairyOpt).toBeTruthy();
  const dairyValue = await select
    .locator("option")
    .filter({ hasText: /Dairy/i })
    .first()
    .getAttribute("value");
  await select.selectOption(dairyValue!);
  observations.push(`UI: merge dialog selected Dairy option value=${dairyValue}`);
  await page.getByRole("button", { name: /^Merge$/i }).click();
  await page.waitForTimeout(2000);
  await expect(pendingCard(page, LABEL_MERGE)).toHaveCount(0, { timeout: 10000 });
  observations.push("UI: Merge — card disappeared; toast expected for merge success");

  const { data: merged } = await supabaseAdmin
    .from("categories")
    .select("is_active, pending_review, status")
    .eq("id", mergeCat.id)
    .single();
  observations.push(`DB after merge: ${JSON.stringify(merged)}`);
  expect(merged?.status).toBe("merged");
  expect(merged?.is_active).toBe(false);

  const { data: dairy } = await supabaseAdmin
    .from("categories")
    .select("id")
    .eq("label", "Dairy")
    .eq("is_active", true)
    .maybeSingle();
  const { data: dairyTerms } = await supabaseAdmin
    .from("category_search_terms")
    .select("term")
    .eq("category_id", dairy!.id)
    .in("term", [
      LABEL_MERGE.toLowerCase(),
      "doodhwala merge",
      "milkman merge",
    ]);
  observations.push(`DB Dairy aliases from merge: ${JSON.stringify(dairyTerms)}`);
  expect((dairyTerms ?? []).length).toBeGreaterThanOrEqual(1);

  // Confirm no new active category with merge label
  const { data: liveMerge } = await supabaseAdmin
    .from("categories")
    .select("id")
    .eq("label", LABEL_MERGE)
    .eq("is_active", true);
  expect(liveMerge ?? []).toHaveLength(0);

  // (c) Reject
  const rejectCard = pendingCard(page, LABEL_REJECT);
  await expect(rejectCard).toBeVisible({ timeout: 10000 });
  observations.push(
    `UI Reject card snippet: ${(await rejectCard.innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
  );
  await rejectCard.getByRole("button", { name: /Reject/i }).click();
  await expect(page.getByText(/Reject this category/i)).toBeVisible();
  await page.getByRole("button", { name: /Confirm reject/i }).click();
  await page.waitForTimeout(2000);
  await expect(pendingCard(page, LABEL_REJECT)).toHaveCount(0, { timeout: 10000 });
  observations.push("UI: Reject confirm — card disappeared from pending list");

  const { data: rejected } = await supabaseAdmin
    .from("categories")
    .select("is_active, pending_review, status")
    .eq("id", rejectCat.id)
    .single();
  observations.push(`DB after reject: ${JSON.stringify(rejected)}`);
  expect(rejected?.is_active).toBe(false);
  expect(rejected?.pending_review).toBe(false);
  expect(rejected?.status).toBe("rejected");

  // No-auto already asserted above (count=2 still pending_review). Confirm still visible in UI.
  const noAutoCard = pendingCard(page, LABEL_NOAUTO);
  await expect(noAutoCard).toBeVisible({ timeout: 10000 });
  await expect(noAutoCard.getByText(/Suggestions:\s*2/i)).toBeVisible();
  observations.push(
    `UI no-auto still pending with count 2: ${(await noAutoCard.innerText()).replace(/\s+/g, " ").slice(0, 200)}`,
  );
});
