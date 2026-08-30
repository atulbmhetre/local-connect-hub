import { test, expect } from "@playwright/test";
import {
  loginAsVendor,
  completeOtpIfVisible,
  APP_URL,
} from "./helpers/browser-setup";
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  ensureVendorGoLivePhotos,
  seedVendorCategory,
  prepareUiOtpSend,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];

async function seedVendor() {
  const category = await getActiveCategoryByServiceMode("delivery");
  const phone = `99003${String(T + createdVendorIds.length).slice(-5)}`;
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: `SessGate ${T}`,
      shop_name: `!SG-${T}`,
      phone,
      category: category.label,
      service_mode: "delivery",
      latitude: 18.5204,
      longitude: 73.8567,
      is_active: false,
      profile_status: "complete",
      service_radius_km: 9999,
      vendor_type: "shop",
      base_type: "shop",
      serves_at_vendor_place: true,
      serves_at_customer_place: true,
    })
    .select("id, phone")
    .single();
  if (error || !vendor) throw new Error(error?.message ?? "seed vendor");
  await seedVendorCategory(vendor.id, category);
  await ensureVendorGoLivePhotos(vendor.id);
  createdVendorIds.push(vendor.id);
  return vendor;
}

test.afterAll(async () => {
  if (createdVendorIds.length === 0) return;
  await supabaseAdmin.from("vendor_categories").delete().in("vendor_id", createdVendorIds);
  await supabaseAdmin.from("vendors").delete().in("id", createdVendorIds);
});

test("D1 returning vendor without session is OTP-gated then can enter dashboard", async ({
  page,
}) => {
  const vendor = await seedVendor();

  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ phone, vendorId }) => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("aaspaas:user_phone", phone);
      localStorage.setItem("aaspaas:vendor_id", vendorId);
      localStorage.setItem("aaspaas:role", "vendor");
      localStorage.setItem("aaspaas:welcomed", "true");
      localStorage.setItem("aaspaas:vendor_onboarded", "true");
      localStorage.setItem("aaspaas:device_id", `sg_${Date.now()}`);
    },
    { phone: vendor.phone, vendorId: vendor.id },
  );

  await prepareUiOtpSend("vendor-returning-otp");
  await page.goto(`${APP_URL}/vendor`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("vendor-screen")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("vendor-returning-otp")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("vendor-golive-btn")).toHaveCount(0);

  await completeOtpIfVisible(page, vendor.phone);
  await expect(page.getByTestId("vendor-returning-otp")).toHaveCount(0);
  await expect(page.getByTestId("vendor-golive-btn")).toBeVisible({ timeout: 20000 });
});

test("D2 returning vendor with live session skips OTP", async ({ page }) => {
  const vendor = await seedVendor();
  await loginAsVendor(page, vendor.phone, vendor.id, `sg_sess_${T}`);
  await page.goto(`${APP_URL}/vendor`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("vendor-screen")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("otp-screen")).toHaveCount(0);
  await expect(page.getByTestId("vendor-returning-otp")).toHaveCount(0);
  await expect(page.getByTestId("vendor-golive-btn")).toBeVisible({ timeout: 20000 });
});
