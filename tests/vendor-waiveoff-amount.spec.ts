/**
 * Phase 6: vendor_amount_due maths on TEST. Does not charge Razorpay.
 */
import { test, expect } from "@playwright/test";
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  seedDefaultVendorVerification,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";
import { loginAsVendor, openVendorPreferencesTab, APP_URL } from "./helpers/browser-setup";
import { strings } from "../src/lib/strings";
import { formatRupeesFromPaise } from "../src/lib/vendorAmountDue";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

test.setTimeout(120_000);

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
});

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor() {
  const cat = await getActiveCategoryByServiceMode("help");
  const phone = nextPhone("99074");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone,
      name: "Waiveoff Maths Vendor",
      shop_name: `!WAIVE-${T}`,
      category: cat.label,
      service_mode: "help",
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
      subscription_status: "active",
      subscription_current_period_end: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id, phone")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, cat, { is_primary: true, modes: ["help"] });
  await seedDefaultVendorVerification(vendor!.id);
  await supabaseAdmin.from("users").upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  return vendor!;
}

async function setWaive(vendorId: string, percent: number | null, months: number | null) {
  const { error } = await supabaseAdmin
    .from("vendors")
    .update({ waiveoff_percent: percent, waiveoff_months_remaining: months })
    .eq("id", vendorId);
  expect(error, error?.message).toBeNull();
}

async function due(vendorId: string) {
  const { data, error } = await supabaseAdmin.rpc("vendor_amount_due", { p_vendor_id: vendorId });
  expect(error, error?.message).toBeNull();
  return data as {
    amount_paise: number;
    base_paise: number;
    waiveoff_percent: number;
    months_remaining: number;
    is_free: boolean;
  };
}

async function snapshotPrice(): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "vendor_subscription_price")
    .single();
  expect(error, error?.message).toBeNull();
  return String(data?.value ?? "99");
}

async function setPrice(value: string) {
  const { error } = await supabaseAdmin
    .from("app_config")
    .update({ value })
    .eq("key", "vendor_subscription_price");
  expect(error, error?.message).toBeNull();
}

test("WAIVE-MATHS — 0/25/50/100%, 33% rounding, months 1 vs 0, clamp, config price", async () => {
  const vendor = await seedVendor();
  const originalPrice = await snapshotPrice();
  try {
    await setPrice("99");
    await setWaive(vendor.id, 0, 3);
    let row = await due(vendor.id);
    expect(row.base_paise).toBe(9900);
    expect(row.amount_paise).toBe(9900);
    expect(row.waiveoff_percent).toBe(0);
    expect(row.months_remaining).toBe(3);
    expect(row.is_free).toBe(false);
    expect(row.amount_paise).toBeLessThanOrEqual(row.base_paise);
    expect(row.amount_paise).toBeGreaterThanOrEqual(0);

    await setWaive(vendor.id, 25, 3);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(7425);
    expect(row.waiveoff_percent).toBe(25);

    await setWaive(vendor.id, 50, 3);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(4950);

    await setWaive(vendor.id, 100, 2);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(0);
    expect(row.is_free).toBe(true);

    await setWaive(vendor.id, 33, 1);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(6633);
    expect(row.months_remaining).toBe(1);

    await setWaive(vendor.id, 33, 0);
    row = await due(vendor.id);
    expect(row.months_remaining).toBe(0);
    expect(row.waiveoff_percent).toBe(0);
    expect(row.amount_paise).toBe(9900);

    await setWaive(vendor.id, 150, 1);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(0);
    expect(row.amount_paise).toBeGreaterThanOrEqual(0);
    expect(row.amount_paise).toBeLessThanOrEqual(row.base_paise);

    await setWaive(vendor.id, -10, 1);
    row = await due(vendor.id);
    expect(row.amount_paise).toBe(9900);
    expect(row.amount_paise).toBeLessThanOrEqual(row.base_paise);

    await setPrice("1.11");
    await setWaive(vendor.id, 33, 1);
    row = await due(vendor.id);
    expect(row.base_paise).toBe(111);
    expect(row.amount_paise).toBe(74);

    await setPrice("149");
    await setWaive(vendor.id, 50, 1);
    row = await due(vendor.id);
    expect(row.base_paise).toBe(14900);
    expect(row.amount_paise).toBe(7450);
  } finally {
    await setPrice(originalPrice);
  }
});

test("WAIVE-UI — vendor billing shows due amount, not flat ₹99, when waive-off is active", async ({
  page,
}) => {
  const vendor = await seedVendor();
  const originalPrice = await snapshotPrice();
  try {
    await setPrice("99");
    await setWaive(vendor.id, 50, 3);
    await loginAsVendor(page, vendor.phone, vendor.id, `device_waive_${vendor.id.slice(0, 8)}`);
    await page.goto(`${APP_URL}/settings`);
    await openVendorPreferencesTab(page);
    const dueEl = page.getByTestId("vendor-sub-amount-due");
    await expect(dueEl).toBeVisible({ timeout: 15_000 });
    const expected = strings.en.vendor_sub_price_month.replace(
      "{amount}",
      formatRupeesFromPaise(4950),
    );
    await expect(dueEl).toHaveText(expected);
    await expect(page.getByTestId("vendor-sub-waiveoff")).toContainText("50%");
    await expect(dueEl).not.toHaveText("₹99/month");
  } finally {
    await setPrice(originalPrice);
  }
});
