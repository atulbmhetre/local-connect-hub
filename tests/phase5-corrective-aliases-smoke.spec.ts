/**
 * Phase 5 live smoke (TEST): exhaust Home rephrase → browse grid →
 * corrective_ai pending alias appears in Settings > Pending Aliases.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase5-corrective-aliases-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import {
  APP_URL,
  ensureTestAdminUser,
  loginAsAdminViaSession,
} from "./helpers/browser-setup";
import { getServiceRoleClient, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

// Unique markers; phrasing avoids category_search_terms / label short-circuits
// (plumber, water, electrician, …) so Home shows the suggest sheet instead of Radar.
const SESSION = `p5c${Date.now().toString().slice(-8)}`;
const FIRST = `someone to unclog my bathroom sink right now ${SESSION}`;
const REPHRASE = `my scooter is making weird knocking sounds ${SESSION}`;
const DEVICE = `p5_corr_device_${SESSION}`;
const admin = getServiceRoleClient();
const observations: string[] = [];
const createdTermIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdTermIds) {
    await admin.from("category_search_terms").delete().eq("id", id);
  }
  await admin
    .from("category_search_terms")
    .delete()
    .eq("source", "corrective_ai")
    .ilike("term", `%${SESSION}%`);
  await admin
    .from("unresolved_search_terms")
    .delete()
    .ilike("term", `%${SESSION}%`);
  await admin
    .from("category_search_term_evidence")
    .delete()
    .ilike("term", `%${SESSION}%`);
  console.log("P5_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("Phase 5: exhausted search lands corrective_ai in Pending Aliases", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await ensureTestAdminUser();

  await page.goto(APP_URL);
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("aaspaas:device_id", deviceId);
    localStorage.setItem("aaspaas:welcomed", "true");
  }, DEVICE);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });

  const search = page.locator("form input[placeholder]").first();
  await search.fill(FIRST);
  await expect(search).toHaveValue(FIRST);
  // SOS uses the same free-text classifier path as form submit (more reliable in PW).
  await page.getByTestId("home-sos-button").click();

  const sheet = page.getByTestId("search-suggest-sheet");
  await expect(sheet).toBeVisible({ timeout: 45_000 });
  await expect(sheet.getByTestId("search-suggest-original-text")).toContainText(FIRST);
  await sheet.getByTestId("search-suggest-none").click();

  const rephraseInput = page.getByTestId("search-suggest-rephrase-input");
  await expect(rephraseInput).toBeVisible({ timeout: 10_000 });
  await rephraseInput.fill(REPHRASE);
  await page.getByTestId("search-suggest-rephrase-submit").click();

  const nextSheet = page.getByTestId("search-suggest-sheet");
  await expect(nextSheet).toBeVisible({ timeout: 45_000 });
  await expect(nextSheet.getByTestId("search-suggest-original-text")).toContainText(
    REPHRASE,
  );
  const topOption = nextSheet.getByTestId("search-suggest-option").first();
  const topText = ((await topOption.innerText()) || "").replace(/\s+/g, " ").trim();
  observations.push(`top candidate after rephrase: ${topText}`);
  await nextSheet.getByTestId("search-suggest-none").click();

  await expect(
    page.getByText(/Couldn't find a match\. Try browsing categories below/i),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.locator("#category-grid")).toBeVisible();
  observations.push("UI: fell through to browse grid");

  // Wait for unresolved + corrective propose
  let unresolved: {
    id: string;
    term: string;
    resolved_category_id: string | null;
  } | null = null;
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from("unresolved_search_terms")
      .select("id, term, resolved_category_id")
      .eq("term", REPHRASE)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      unresolved = data;
      if (data.resolved_category_id) break;
    }
    await page.waitForTimeout(1000);
  }
  expect(unresolved, "unresolved_search_terms row").toBeTruthy();
  observations.push(`unresolved row: ${JSON.stringify(unresolved)}`);

  let evidence: { category_id: string; term: string; actor_key: string } | null = null;
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from("category_search_term_evidence")
      .select("category_id, term, actor_key")
      .eq("source", "corrective_ai")
      .eq("term", REPHRASE.toLowerCase())
      .limit(1)
      .maybeSingle();
    if (data) {
      evidence = data;
      break;
    }
    await page.waitForTimeout(1000);
  }
  expect(evidence, "corrective evidence after one customer").toBeTruthy();

  const { data: tooSoon } = await admin
    .from("category_search_terms")
    .select("id")
    .eq("term", REPHRASE.toLowerCase())
    .eq("status", "pending_review")
    .maybeSingle();
  expect(tooSoon, "single customer must not reach pending_review").toBeNull();

  for (const actor of [`p5-a-${SESSION}`, `p5-b-${SESSION}`]) {
    await admin.rpc("record_search_alias_evidence", {
      p_category_id: evidence!.category_id,
      p_term: evidence!.term,
      p_source: "corrective_ai",
      p_actor_key: actor,
      p_confidence: 0.7,
      p_ai_reasoning: "synthetic second/third customer for threshold",
      p_suggested_by_vendor_id: null,
    });
  }

  let corrective: {
    id: string;
    term: string;
    source: string;
    status: string;
    ai_reasoning: string | null;
    category_id: string;
  } | null = null;
  for (let i = 0; i < 30; i++) {
    const { data } = await admin
      .from("category_search_terms")
      .select("id, term, source, status, ai_reasoning, category_id")
      .eq("term", REPHRASE.toLowerCase())
      .eq("source", "corrective_ai")
      .eq("status", "pending_review")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      corrective = data;
      createdTermIds.push(data.id);
      break;
    }
    await page.waitForTimeout(1000);
  }
  expect(corrective, "corrective_ai pending alias").toBeTruthy();
  expect(corrective!.term).toBe(REPHRASE.toLowerCase());
  expect(corrective!.ai_reasoning?.toLowerCase()).toMatch(/customer|exhausted|best-guess/);
  observations.push(`corrective pending: ${JSON.stringify(corrective)}`);

  // resolved_category_id should be set (may lag slightly after insert)
  for (let i = 0; i < 15; i++) {
    const { data } = await admin
      .from("unresolved_search_terms")
      .select("resolved_category_id")
      .eq("id", unresolved!.id)
      .single();
    if (data?.resolved_category_id) {
      unresolved = { ...unresolved!, resolved_category_id: data.resolved_category_id };
      break;
    }
    await page.waitForTimeout(500);
  }
  expect(unresolved!.resolved_category_id).toBe(corrective!.category_id);
  observations.push(
    `unresolved marked resolved_category_id=${unresolved!.resolved_category_id}`,
  );

  // Admin UI shows corrective source clearly
  await loginAsAdminViaSession(page, `p5_admin_${SESSION}`);
  await expect(page.getByTestId("admin-panel")).toBeVisible({ timeout: 15_000 });
  const pendingBtn = page.getByRole("button", { name: /Pending Aliases/i });
  await expect(pendingBtn).toBeVisible({ timeout: 10_000 });
  await pendingBtn.click();

  const card = page.getByTestId(`pending-alias-card-${corrective!.id}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/customer search miss/i)).toBeVisible();
  await expect(card.getByText(/A real customer typed this/i)).toBeVisible();
  await expect(card.getByText(/exhausted suggestions/i).first()).toBeVisible();
  observations.push(
    `UI card: ${(await card.innerText()).replace(/\s+/g, " ").slice(0, 360)}`,
  );

  console.log("P5_SMOKE_OK", {
    term: corrective!.term,
    category_id: corrective!.category_id,
    unresolved_id: unresolved!.id,
  });
});
