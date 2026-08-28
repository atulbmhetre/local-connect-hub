/**
 * Live smoke: Home search exhaust → rephrase → fall through to browse grid,
 * then confirm unresolved_search_terms row on TEST.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/unresolved-search-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import { getServiceRoleClient, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

// Unique markers; phrasing avoids category_search_terms substrings (plumber/water/engine/…)
// so alias exact-match does not skip the suggest sheet. Pure gibberish hits honesty
// no_confident_match — use rejectable AI candidates instead.
const SESSION = `zzqx827_${Date.now()}`;
const FIRST = `someone to unclog my bathroom sink right now ${SESSION}`;
const REPHRASE = `my scooter is making weird knocking sounds ${SESSION}`;
const DEVICE = `unresolved_smoke_${Date.now()}`;

const admin = getServiceRoleClient();

test("Home rephrase exhaust falls through to browse + logs unresolved term", async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto(APP_URL);
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("aaspaas:device_id", deviceId);
    localStorage.setItem("aaspaas:welcomed", "true");
  }, DEVICE);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });

  const search = page.locator('form input[placeholder]').first();
  await search.fill(FIRST);
  await expect(search).toHaveValue(FIRST);
  // SOS runs the same free-text classifier path as form submit.
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
  await nextSheet.getByTestId("search-suggest-none").click();

  await expect(
    page.getByText(/Couldn't find a match\. Try browsing categories below/i),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("search-suggest-sheet")).toHaveCount(0);
  await expect(page.locator("#category-grid")).toBeVisible();

  // Allow fire-and-forget RPC to land.
  let row: {
    term: string;
    original_term_if_rephrased: string | null;
    resolved_category_id: string | null;
  } | null = null;
  for (let i = 0; i < 20; i++) {
    const { data, error } = await admin
      .from("unresolved_search_terms")
      .select("term, original_term_if_rephrased, resolved_category_id, created_at")
      .eq("term", REPHRASE)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      row = data;
      break;
    }
    await page.waitForTimeout(500);
  }

  expect(row, "expected unresolved_search_terms row for rephrased term").toBeTruthy();
  expect(row!.term).toBe(REPHRASE);
  expect(row!.original_term_if_rephrased).toBe(FIRST);
  expect(row!.resolved_category_id).toBeNull();
  console.log("SMOKE_OK", JSON.stringify(row));
});
