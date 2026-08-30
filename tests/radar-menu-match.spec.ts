/**
 * Radar second-pass: help/appointment menu-name ranking (not hard filter).
 *
 * Uses a dedicated help category so Track A's unordered 80-row cap cannot drop
 * the three seeds among the dense Pune Electrician set. Ranking still runs
 * after category resolution — same path as Electrician + "CCTV installation".
 *
 * The temporary category_search_terms row is test scaffolding only. The feature
 * itself never writes that table.
 */
import { test, expect, type Page } from "@playwright/test";
import { APP_URL } from "./helpers/browser-setup";
import {
  supabaseAdmin,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";

const T = Date.now();
const SEARCH = "CCTV installation";
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
let createdCategoryId: string | null = null;
let aliasId: string | null = null;

async function seedHelpVendor(
  shopName: string,
  phone: string,
  pin: { latitude: number; longitude: number },
  cat: { id: string; service_mode: string },
) {
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone,
      name: shopName,
      shop_name: shopName,
      category: cat.service_mode === "help" ? "Electrician" : cat.service_mode,
      service_mode: "help",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: pin.latitude,
      longitude: pin.longitude,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, cat, {
    is_primary: true,
    modes: ["help"],
    service_radius_km: 15,
    latitude: pin.latitude,
    longitude: pin.longitude,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
  });
  return vendor!.id;
}

async function gotoRadar(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation(PUNE);
  await page.goto(
    `${APP_URL}/radar?q=${encodeURIComponent(SEARCH)}&mode=help`,
    { waitUntil: "domcontentloaded" },
  );
  await page.getByTestId("radar-search-input").waitFor({ state: "visible", timeout: 15000 });
}

test.afterAll(async () => {
  if (aliasId) {
    await supabaseAdmin.from("category_search_terms").delete().eq("id", aliasId);
  }
  if (createdCategoryId) {
    await supabaseAdmin
      .from("category_search_terms")
      .delete()
      .eq("category_id", createdCategoryId);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  if (createdCategoryId) {
    await supabaseAdmin.from("categories").delete().eq("id", createdCategoryId);
  }
});

test("RAD-MENU-01 — CCTV menu match ranks higher and highlights; others stay visible", async ({
  page,
}) => {
  test.setTimeout(90_000);

  // Drop leftover test aliases from earlier Electrician-scoped runs so this
  // term does not also resolve to the dense Electrician set.
  await supabaseAdmin.from("category_search_terms").delete().ilike("term", SEARCH);

  const { data: cat, error: catErr } = await supabaseAdmin
    .from("categories")
    .insert({
      label: `!RAD-MM-CAT-${T}`,
      emoji: "💡",
      service_mode: "help",
      is_active: true,
      pending_review: false,
      status: "active",
      sort_order: 99,
    })
    .select("id, label, service_mode")
    .single();
  expect(catErr, catErr?.message).toBeNull();
  createdCategoryId = cat!.id;

  const { data: inserted, error: aliasErr } = await supabaseAdmin
    .from("category_search_terms")
    .insert({
      category_id: cat!.id,
      term: SEARCH.toLowerCase(),
      language: "en",
      source: "manual",
      status: "active",
    })
    .select("id")
    .single();
  expect(aliasErr, aliasErr?.message).toBeNull();
  aliasId = inserted!.id;

  const emptyId = await seedHelpVendor(
    `!RAD-MM-EMPTY-${T}`,
    `99071${String(T).slice(-5)}`,
    PUNE,
    cat!,
  );
  const missId = await seedHelpVendor(
    `!RAD-MM-MISS-${T}`,
    `99072${String(T).slice(-5)}`,
    { latitude: 18.521, longitude: 73.8567 },
    cat!,
  );
  const hitId = await seedHelpVendor(
    `!RAD-MM-HIT-${T}`,
    `99073${String(T).slice(-5)}`,
    { latitude: 18.522, longitude: 73.8567 },
    cat!,
  );

  const { error: missMenuErr } = await supabaseAdmin.from("vendor_menu_items").insert({
    vendor_id: missId,
    category_id: cat!.id,
    name: "Fan repair",
    price: 200,
    unit: "point",
    is_available: true,
    sort_order: 0,
  });
  expect(missMenuErr, missMenuErr?.message).toBeNull();

  const { error: hitMenuErr } = await supabaseAdmin.from("vendor_menu_items").insert({
    vendor_id: hitId,
    category_id: cat!.id,
    name: SEARCH,
    price: 1500,
    unit: "job",
    is_available: true,
    sort_order: 0,
  });
  expect(hitMenuErr, hitMenuErr?.message).toBeNull();

  await gotoRadar(page);
  await expect(page.locator('[data-scanning="false"]')).toBeVisible({ timeout: 30000 });

  const hitCard = page.locator(`[data-vendor-id="${hitId}"]`);
  const missCard = page.locator(`[data-vendor-id="${missId}"]`);
  const emptyCard = page.locator(`[data-vendor-id="${emptyId}"]`);
  await expect(hitCard).toBeVisible({ timeout: 20000 });
  await expect(missCard).toBeVisible({ timeout: 20000 });
  await expect(emptyCard).toBeVisible({ timeout: 20000 });

  await expect(hitCard).toHaveAttribute("data-menu-match", "true");
  await expect(hitCard.getByTestId("radar-menu-match")).toContainText(SEARCH);
  await expect(missCard.getByTestId("radar-menu-match")).toHaveCount(0);
  await expect(emptyCard.getByTestId("radar-menu-match")).toHaveCount(0);

  const order = await page.locator('[data-testid="radar-vendor-card"]').evaluateAll(
    (els, ids: { hit: string; miss: string; empty: string }) => {
      const indexOf = (id: string) =>
        els.findIndex((el) => el.getAttribute("data-vendor-id") === id);
      return {
        hit: indexOf(ids.hit),
        miss: indexOf(ids.miss),
        empty: indexOf(ids.empty),
      };
    },
    { hit: hitId, miss: missId, empty: emptyId },
  );
  expect(order.hit).toBeGreaterThanOrEqual(0);
  expect(order.hit).toBeLessThan(order.empty);
  expect(order.hit).toBeLessThan(order.miss);
});
