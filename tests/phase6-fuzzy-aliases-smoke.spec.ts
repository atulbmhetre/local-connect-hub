/**
 * Phase 6 live smoke (TEST): Home search for a typo ("mecanik") surfaces
 * Mechanic on the Did-you-mean sheet (not honesty unavailable / silent Radar).
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase6-fuzzy-aliases-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import { getServiceRoleClient, loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const SESSION = `p6f${Date.now().toString().slice(-8)}`;
const TYPO = `mecanik`;
const DEVICE = `p6_fuzzy_device_${SESSION}`;
const admin = getServiceRoleClient();
const observations: string[] = [];

test.afterAll(async () => {
  console.log("P6_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("Phase 6: typo search shows Did you mean candidate (not unavailable)", async ({
  page,
}) => {
  test.setTimeout(120_000);

  // DB sanity: RPC must resolve mecanik → Mechanic on TEST
  const { data: rpcHits, error: rpcErr } = await admin.rpc(
    "fuzzy_match_category_search_terms",
    { p_input: TYPO, p_threshold: 0.3 },
  );
  expect(rpcErr, String(rpcErr)).toBeNull();
  expect(
    (rpcHits as { label?: string }[] | null)?.some((h) => h.label === "Mechanic"),
  ).toBe(true);
  observations.push(`RPC mecanik → ${JSON.stringify(rpcHits)}`);

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
  await search.fill(TYPO);
  await expect(search).toHaveValue(TYPO);
  await page.getByTestId("home-sos-button").click();

  const sheet = page.getByTestId("search-suggest-sheet");
  const unavailable = page.getByText(/isn't available yet/i);
  await Promise.race([
    sheet.waitFor({ state: "visible", timeout: 30_000 }),
    unavailable.waitFor({ state: "visible", timeout: 30_000 }).then(async () => {
      throw new Error(
        `Typo hit honesty unavailable instead of Did-you-mean sheet. value=${await search.inputValue()}`,
      );
    }),
  ]);

  await expect(sheet.getByTestId("search-suggest-original-text")).toContainText(TYPO);
  const optionTexts = await sheet.getByTestId("search-suggest-option").allTextContents();
  observations.push(`suggest options: ${JSON.stringify(optionTexts)}`);
  expect(
    optionTexts.some((t) => /mechanic/i.test(t)),
    `expected Mechanic in ${JSON.stringify(optionTexts)}`,
  ).toBe(true);

  // Must NOT have silently navigated to Radar
  await expect(page).toHaveURL(/\/?(\?.*)?$/);
  expect(page.url()).not.toMatch(/\/radar/i);

  console.log("P6_SMOKE_OK", { typo: TYPO, options: optionTexts });
});
