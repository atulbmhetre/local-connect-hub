import { test, expect } from "@playwright/test";
import { loginAsCustomer, APP_URL } from "./helpers/browser-setup";
import {
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_VENDOR_SHOP_PHOTO,
} from "./helpers/setup";

const T = Date.now();
const CUSTOMER_PHONE = `88029${String(T).slice(-5)}`;
const DEVICE_ID = `device_ifee_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_verification").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
  await supabaseAdmin.from("users").delete().eq("phone", CUSTOMER_PHONE);
});

test("IFE-01 — inspection fee chip on Radar card and sticky Parchi footer", async ({
  page,
}) => {
  const electrician = await getActiveCategoryByLabel("Electrician");
  const shopName = `!IFEE-${T}`;
  const fee = 100;

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Inspection Fee Owner",
      shop_name: shopName,
      phone: `99029${String(T).slice(-5)}`,
      category: electrician.label,
      service_mode: electrician.service_mode,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      is_active: true,
      profile_status: "complete",
      discoverable: true,
      subscription_status: "active",
      service_radius_km: 9999,
      serves_at_customer_place: true,
      serves_at_vendor_place: true,
    })
    .select("id")
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);

  await seedVendorCategory(vendor.id, electrician, {
    is_primary: true,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    service_radius_km: 9999,
    modes: ["help"],
  });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from("vendors")
    .update({ discoverable: true, subscription_status: "active" })
    .eq("id", vendor.id);
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      inspection_fee: fee,
      service_radius_km: 9999,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: "business_verified",
    })
    .eq("vendor_id", vendor.id)
    .eq("category_id", electrician.id);

  await supabaseAdmin
    .from("users")
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: "phone" });

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: PUNE.latitude, longitude: PUNE.longitude });
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/radar?mode=help&q=${encodeURIComponent(electrician.label)}`);
  const panIndia = page.getByRole("button", { name: /Pan-India/i });
  if (await panIndia.isVisible().catch(() => false)) {
    await panIndia.click();
  }

  const card = page.getByTestId("radar-vendor-card").filter({ hasText: shopName }).first();
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card.getByTestId("radar-inspection-fee-chip")).toContainText("₹100");

  await card.getByTestId("radar-vendor-card-order-btn").click();
  await expect(page.getByTestId("parchi-sheet")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("parchi-inspection-fee")).toBeVisible();
  await expect(page.getByTestId("parchi-inspection-fee")).toContainText("₹100");
  await expect(page.getByTestId("parchi-submit-btn")).toBeVisible();
});
