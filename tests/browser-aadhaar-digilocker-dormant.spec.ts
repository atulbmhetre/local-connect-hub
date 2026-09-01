import { test, expect } from "@playwright/test";
import {
  loginAsVendor,
  openVendorPreferencesTab,
  APP_URL,
} from "./helpers/browser-setup";
import { supabaseAdmin, getActiveCategoryByServiceMode, seedVendorCategory } from "./helpers/setup";

const T = Date.now();
const DEVICE_ID = `device_aadhaar_${T}`;
const createdVendorIds: string[] = [];

test.afterAll(async () => {
  if (createdVendorIds.length) {
    await supabaseAdmin.from("vendor_verification").delete().in("vendor_id", createdVendorIds);
    await supabaseAdmin.from("vendors").delete().in("id", createdVendorIds);
  }
});

test("vendor Aadhaar button is coming-soon: no edge invoke, no DigiLocker URL", async ({
  page,
}) => {
  const category = await getActiveCategoryByServiceMode("delivery");
  const phone = `9900${String(T).slice(-6)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Aadhaar Dormant",
      shop_name: `!AADHAAR-${T}`,
      phone,
      category: category.label,
      service_mode: "delivery",
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: true,
      profile_status: "complete",
      is_banned: false,
    })
    .select("id, phone")
    .single();
  if (error || !vendor) throw error ?? new Error("seed vendor failed");
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, category);

  let edgeHits = 0;
  await page.route("**/functions/v1/aadhaar-digilocker-**", async (route) => {
    edgeHits += 1;
    await route.abort();
  });
  await page.route("**/*decentro.tech/**", async (route) => {
    edgeHits += 1;
    await route.abort();
  });

  await loginAsVendor(page, vendor.phone, vendor.id, DEVICE_ID);
  await page.goto(`${APP_URL}/settings`);
  await expect(page.getByTestId("settings-screen")).toBeVisible({ timeout: 20000 });
  await openVendorPreferencesTab(page);

  const prefs = page.getByRole("button", { name: /preferences/i }).first();
  if (await prefs.isVisible().catch(() => false)) {
    const expanded = await prefs.getAttribute("aria-expanded");
    if (expanded !== "true") await prefs.click();
  }

  const btn = page.getByTestId("aadhaar-digilocker-verify-btn");
  await expect(btn).toBeVisible({ timeout: 15000 });
  await btn.click();

  await expect(page.getByText(/Aadhaar verification coming soon/i)).toBeVisible({
    timeout: 8000,
  });
  expect(edgeHits).toBe(0);
});
