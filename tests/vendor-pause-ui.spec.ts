/**
 * Phase 3: vendor pause UI — preflight sheet, confirm dialog, resume toast.
 */
import { test, expect } from "@playwright/test";
import {
  loginAsVendor,
  openVendorMyBusinessTab,
  expandMyBusinessCategoryAccordion,
  APP_URL,
} from "./helpers/browser-setup";
import {
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  seedDefaultVendorVerification,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";
import { strings } from "../src/lib/strings";
import { fillPauseTemplate } from "../src/lib/vendorPauseUi";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdRequestIds: string[] = [];

test.setTimeout(90_000);

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_billing_pauses").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_pause_events").delete().eq("vendor_id", id);
    const { data: reqs } = await supabaseAdmin.from("requests").select("id").eq("vendor_id", id);
    const ids = (reqs ?? []).map((r) => r.id as string);
    if (ids.length) {
      await supabaseAdmin.from("order_items").delete().in("request_id", ids);
      await supabaseAdmin.from("requests").delete().in("id", ids);
    }
    await deleteVendorRegistrationArtifacts(id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
});

function nextPhone(prefix: string): string {
  const phone = `${prefix}${String(T + createdPhones.length + 1).slice(-5)}`;
  createdPhones.push(phone);
  return phone;
}

async function seedVendor(shop: string) {
  const cat = await getActiveCategoryByServiceMode("help");
  const phone = nextPhone("99073");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone,
      name: "Pause UI Vendor",
      shop_name: shop,
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
      subscription_status: "trial",
      trial_ends_at: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id, phone")
    .single();
  if (error) throw error;
  createdVendorIds.push(vendor.id);
  await seedVendorCategory(vendor.id, cat, { is_primary: true, modes: ["help"] });
  await seedDefaultVendorVerification(vendor.id);
  return { vendor, cat, phone };
}

async function insertOpenHelp(vendorId: string, categoryId: string) {
  const customerPhone = nextPhone("88073");
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data, error } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: `pause-ui-${T}-${createdRequestIds.length}`,
      vendor_id: vendorId,
      message: "pause-ui-open-help",
      user_phone: customerPhone,
      status: "sent",
      category_id: categoryId,
      service_mode: "help",
      payment_status: "unpaid",
    })
    .select("id")
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
}

async function openPauseSwitch(
  page: import("@playwright/test").Page,
  vendorId: string,
  phone: string,
  categoryId: string,
) {
  await loginAsVendor(page, phone, vendorId, `device_pause_ui_${vendorId.slice(0, 8)}`);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expandMyBusinessCategoryAccordion(page, categoryId);
  const sw = page.getByTestId(`my-business-pause-${categoryId}`);
  await expect(sw).toBeVisible({ timeout: 15_000 });
  return sw;
}

test("PAUSE-UI-01 — open work shows blocking sheet with Help count and serve-or-cancel", async ({
  page,
}) => {
  const { vendor, cat, phone } = await seedVendor(`!PAUSE-UI-OPEN-${T}`);
  await insertOpenHelp(vendor.id, cat.id);
  const sw = await openPauseSwitch(page, vendor.id, phone, cat.id);
  await sw.click();

  const sheet = page.getByTestId("vendor-pause-blocked-sheet");
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet.getByText(strings.en.vendor_pause_open_work_serve)).toBeVisible();
  await expect(page.getByTestId("vendor-pause-open-work-count-help")).toHaveText("1");
  await expect(page.getByTestId("vendor-pause-open-work-link-help")).toBeVisible();
  await expect(page.getByTestId("vendor-pause-confirm-dialog")).toHaveCount(0);

  const html = await sheet.innerHTML();
  expect(html).toContain("Serve or cancel these first.");
  console.log(
    JSON.stringify({
      evidence: "PAUSE-UI-01",
      vendor_id: vendor.id,
      sheet_text: await sheet.innerText(),
    }),
  );
});

test("PAUSE-UI-02 — allowed pause shows confirm note + billing freeze; resume toast", async ({
  page,
}) => {
  const { vendor, cat, phone } = await seedVendor(`!PAUSE-UI-OK-${T}`);
  const sw = await openPauseSwitch(page, vendor.id, phone, cat.id);
  await sw.click();

  const dialog = page.getByTestId("vendor-pause-confirm-dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  const expectedNote = fillPauseTemplate(strings.en.vendor_pause_note, { N: 7 });
  await expect(page.getByTestId("vendor-pause-confirm-note")).toHaveText(expectedNote);
  await expect(page.getByTestId("vendor-pause-confirm-billing")).toHaveText(
    strings.en.vendor_pause_billing_freeze,
  );

  console.log(
    JSON.stringify({
      evidence: "PAUSE-UI-02-confirm",
      vendor_id: vendor.id,
      dialog_text: await dialog.innerText(),
    }),
  );

  await page.getByTestId("vendor-pause-confirm-action").click();
  await expect(page.locator("[data-sonner-toast]").getByText(strings.en.vendor_pause_saved)).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId(`my-business-paused-since-${cat.id}`)).toBeVisible();
  await expect(page.getByTestId(`my-business-paused-since-${cat.id}`)).toContainText("Paused since");

  await sw.click();
  const underMin = fillPauseTemplate(strings.en.vendor_pause_resume_under_min, { Y: 0, N: 7 });
  await expect(page.locator("[data-sonner-toast]").getByText(underMin)).toBeVisible({
    timeout: 15_000,
  });

  console.log(
    JSON.stringify({
      evidence: "PAUSE-UI-02-resume",
      vendor_id: vendor.id,
      resume_toast: underMin,
    }),
  );
});

test("PAUSE-UI-03 — grace subscription shows matching blocked message", async ({ page }) => {
  const { vendor, cat, phone } = await seedVendor(`!PAUSE-UI-GRACE-${T}`);
  await supabaseAdmin.from("vendors").update({ subscription_status: "grace" }).eq("id", vendor.id);
  const sw = await openPauseSwitch(page, vendor.id, phone, cat.id);
  await sw.click();
  await expect(page.getByTestId("vendor-pause-blocked-sheet")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("vendor-pause-subscription-body")).toHaveText(
    strings.en.vendor_pause_blocked_grace,
  );
  await expect(page.getByText(strings.en.vendor_pause_save_failed)).toHaveCount(0);
});
