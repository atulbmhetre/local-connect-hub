/**
 * Phase 7 live smoke (TEST): multi exact alias (testmilk → Dairy + Grocery Store)
 * lands Radar with vendors from both categories, visibly grouped.
 *
 * Run: PW_REUSE_DEV_SERVER=true npx playwright test tests/phase7-multi-category-radar-smoke.spec.ts --retries=0
 */
import { expect, test } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import {
  deleteVendorRegistrationArtifacts,
  getActiveCategoryByLabel,
  invokeRegisterVendorRpc,
  supabaseAdmin,
} from "./helpers/setup";
import { loadTestEnv } from "./helpers/testEnv";

loadTestEnv();

const SESSION = `p7m${Date.now().toString().slice(-8)}`;
const TERM = `testmilk${SESSION}`;
const DEVICE = `p7_multi_device_${SESSION}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const observations: string[] = [];
const vendorIds: string[] = [];
const aliasIds: string[] = [];

test.afterAll(async () => {
  for (const id of aliasIds) {
    await supabaseAdmin.from("category_search_terms").delete().eq("id", id);
  }
  await supabaseAdmin
    .from("category_search_terms")
    .delete()
    .eq("term", TERM.toLowerCase());
  for (const id of vendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  console.log("P7_SMOKE_OBSERVATIONS\n" + observations.join("\n"));
});

test("Phase 7: multi-alias search shows grouped Dairy + Grocery results", async ({
  page,
}) => {
  test.setTimeout(180_000);

  const dairy = await getActiveCategoryByLabel("Dairy");
  const grocery = await getActiveCategoryByLabel("Grocery Store");
  expect(dairy.service_mode).toBe("delivery");
  expect(grocery.service_mode).toBe("delivery");

  // Seed multi exact aliases (Phase 2 pattern)
  for (const cat of [dairy, grocery]) {
    const { data, error } = await supabaseAdmin
      .from("category_search_terms")
      .insert({
        category_id: cat.id,
        term: TERM.toLowerCase(),
        language: "en",
        source: "manual",
        status: "active",
      })
      .select("id")
      .single();
    expect(error, String(error)).toBeNull();
    if (data?.id) aliasIds.push(data.id);
  }
  observations.push(`seeded aliases for ${TERM} → Dairy + Grocery Store`);

  const dairyShop = `!P7-Dairy-${SESSION}`;
  const groceryShop = `!P7-Grocery-${SESSION}`;

  for (const [cat, shop] of [
    [dairy, dairyShop],
    [grocery, groceryShop],
  ] as const) {
    const reg = await invokeRegisterVendorRpc({
      shop_name: shop,
      category: cat.label,
      category_ids: [cat.id],
      category_service_modes: [cat.service_mode],
      service_mode: cat.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      profile_status: "complete",
      service_radius_km: 50,
      serves_at_vendor_place: true,
      serves_at_customer_place: true,
    });
    expect(reg.error, JSON.stringify(reg.error)).toBeUndefined();
    const vendorId = reg.vendorId!;
    vendorIds.push(vendorId);
    await supabaseAdmin
      .from("vendors")
      .update({
        is_active: true,
        profile_status: "complete",
        discoverable: true,
        service_radius_km: 50,
        latitude: PUNE.latitude,
        longitude: PUNE.longitude,
      })
      .eq("id", vendorId);
    await supabaseAdmin
      .from("vendor_categories")
      .update({
        latitude: PUNE.latitude,
        longitude: PUNE.longitude,
        service_radius_km: 50,
        serves_at_customer_place: true,
        status: "approved",
      })
      .eq("vendor_id", vendorId)
      .eq("category_id", cat.id);
  }
  observations.push(`seeded vendors ${dairyShop} / ${groceryShop}`);

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation(PUNE);

  await page.goto(APP_URL);
  await page.evaluate((deviceId) => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem("aaspaas:device_id", deviceId);
    localStorage.setItem("aaspaas:welcomed", "true");
  }, DEVICE);
  await page.goto(`${APP_URL}/`);
  await expect(page.getByTestId("home-screen")).toBeVisible({ timeout: 20_000 });

  // Wait for categories (+ search-term cache refresh) to settle
  await page.waitForTimeout(1500);

  const search = page.locator("form input[placeholder]").first();
  await search.fill(TERM);
  await expect(search).toHaveValue(TERM);
  await search.press("Enter");

  // Must NOT open Did-you-mean sheet — multi exact goes straight to Radar
  await expect(page.getByTestId("search-suggest-sheet")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/radar\\?.*q=${encodeURIComponent(TERM)}`), {
    timeout: 20_000,
  });
  observations.push(`navigated ${page.url()}`);

  await expect(page.getByTestId(`radar-category-group-${dairy.id}`)).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByTestId(`radar-category-group-${grocery.id}`)).toBeVisible({
    timeout: 20_000,
  });

  const headers = page.getByTestId("radar-category-group-header");
  await expect(headers).toHaveCount(2);
  const headerText = (await headers.allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
  observations.push(`group headers: ${JSON.stringify(headerText)}`);
  expect(headerText.some((t) => /Dairy/i.test(t))).toBe(true);
  expect(headerText.some((t) => /Grocery/i.test(t))).toBe(true);

  await expect(
    page.getByTestId("radar-vendor-card").filter({ hasText: dairyShop }),
  ).toBeVisible();
  await expect(
    page.getByTestId("radar-vendor-card").filter({ hasText: groceryShop }),
  ).toBeVisible();

  console.log("P7_SMOKE_OK", { term: TERM, headers: headerText });
});
