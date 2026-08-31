import { test, expect } from "@playwright/test";
import {
  loginAsCustomer,
  loginAsVendor,
  openVendorMyBusinessTab,
  expandMyBusinessCategoryAccordion,
  APP_URL,
} from "./helpers/browser-setup";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  seedDefaultVendorVerification,
  TEST_VENDOR_SHOP_PHOTO,
} from "./helpers/setup";

const T = Date.now();
const CUSTOMER_PHONE = `88031${String(T).slice(-5)}`;
const VENDOR_NOMENU_PHONE = `99033${String(T).slice(-5)}`;
const DEVICE_ID = `device_minord_${T}`;
const PUNE = { latitude: 18.5204, longitude: 73.8567 };
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_menu_items").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_categories").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_verification").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendors").delete().eq("id", id);
  }
  await supabaseAdmin.from("users").delete().eq("phone", CUSTOMER_PHONE);
  await supabaseAdmin.from("users").delete().eq("phone", VENDOR_NOMENU_PHONE);
});

test("MINDEL-RPC — below min rejected, at min inserts items jsonb", async () => {
  test.setTimeout(60_000);
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const shopName = `!MINDEL-RPC-${T}`;
  const itemName = `MinDel Item ${T}`;

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Min Delivery Owner",
      shop_name: shopName,
      phone: `99031${String(T).slice(-5)}`,
      category: grocery.label,
      service_mode: "delivery",
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

  await seedVendorCategory(vendor.id, grocery, {
    is_primary: true,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    service_radius_km: 9999,
    modes: ["delivery"],
  });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from("vendors")
    .update({ discoverable: true, subscription_status: "active" })
    .eq("id", vendor.id);
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      min_delivery_order_amount: 200,
      service_radius_km: 9999,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: "business_verified",
    })
    .eq("vendor_id", vendor.id)
    .eq("category_id", grocery.id);

  const { data: menuRow, error: menuErr } = await supabaseAdmin
    .from("vendor_menu_items")
    .insert({
      vendor_id: vendor.id,
      category_id: grocery.id,
      name: itemName,
      price: 50,
      unit: "pc",
      is_available: true,
      sort_order: 0,
    })
    .select("id")
    .single();
  if (menuErr) throw menuErr;

  await supabaseAdmin
    .from("users")
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: "phone" });

  const below = await supabase.rpc("create_customer_request", {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendor.id,
    p_message: `below min ${T}`,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "MinDel test address",
    p_delivery_slot: "tomorrow",
    p_items: [
      { item_id: menuRow.id, name: itemName, quantity: 1, unit_price: 50, unit: "pc" },
    ],
  });
  expect(below.error?.message ?? "", "RPC below min").toMatch(/below_min_delivery_order/);
  expect(below.data, "RPC below min must not insert").toBeNull();

  const ok = await supabase.rpc("create_customer_request", {
    p_device_id: DEVICE_ID,
    p_vendor_id: vendor.id,
    p_message: `at min ${T}`,
    p_user_phone: CUSTOMER_PHONE,
    p_device_id_log: DEVICE_ID,
    p_service_mode: "delivery",
    p_category_id: grocery.id,
    p_delivery_address: "MinDel test address",
    p_delivery_slot: "tomorrow",
    p_items: [
      { item_id: menuRow.id, name: itemName, quantity: 4, unit_price: 50, unit: "pc" },
    ],
  });
  expect(ok.error, ok.error?.message).toBeNull();
  expect(ok.data).toBeTruthy();
  createdRequestIds.push(ok.data as string);

  const { data: saved, error: savedErr } = await supabaseAdmin
    .from("requests")
    .select("id, items, service_mode")
    .eq("id", ok.data as string)
    .single();
  if (savedErr) throw savedErr;
  expect(saved.service_mode).toBe("delivery");
  expect(Array.isArray(saved.items)).toBe(true);
  expect(saved.items).not.toBeNull();
  expect(saved.items[0].quantity).toBe(4);
  expect(Number(saved.items[0].unit_price)).toBe(50);
});

test("MINDEL-UI — below min disables submit; cart survives Add to order", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const shopName = `!MINDEL-UI-${T}`;
  const itemName = `MinDel UI ${T}`;

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Min Delivery UI",
      shop_name: shopName,
      phone: `99032${String(T).slice(-5)}`,
      category: grocery.label,
      service_mode: "delivery",
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

  await seedVendorCategory(vendor.id, grocery, {
    is_primary: true,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    service_radius_km: 9999,
    modes: ["delivery"],
  });
  await seedDefaultVendorVerification(vendor.id);
  await supabaseAdmin
    .from("vendors")
    .update({ discoverable: true, subscription_status: "active" })
    .eq("id", vendor.id);
  await supabaseAdmin
    .from("vendor_categories")
    .update({
      min_delivery_order_amount: 200,
      service_radius_km: 9999,
      shop_photo_url: TEST_VENDOR_SHOP_PHOTO,
      latitude: PUNE.latitude,
      longitude: PUNE.longitude,
      gps_match_distance: 10,
      verification_status: "business_verified",
    })
    .eq("vendor_id", vendor.id)
    .eq("category_id", grocery.id);

  await supabaseAdmin.from("vendor_menu_items").insert({
    vendor_id: vendor.id,
    category_id: grocery.id,
    name: itemName,
    price: 50,
    unit: "pc",
    is_available: true,
    sort_order: 0,
  });

  await supabaseAdmin
    .from("users")
    .upsert({ phone: CUSTOMER_PHONE, trust_score: 75 }, { onConflict: "phone" });

  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: PUNE.latitude, longitude: PUNE.longitude });
  await loginAsCustomer(page, CUSTOMER_PHONE, DEVICE_ID);
  await page.goto(`${APP_URL}/radar?mode=delivery&q=${encodeURIComponent(grocery.label)}`);
  const panIndia = page.getByRole("button", { name: /Pan-India/i });
  if (await panIndia.isVisible().catch(() => false)) {
    await panIndia.click();
  }

  const card = page.locator(
    `[data-testid="radar-vendor-card"][data-vendor-id="${vendor.id}"]`,
  );
  await expect(card).toBeVisible({ timeout: 25_000 });
  await card.scrollIntoViewIfNeeded();
  await card.getByTestId("radar-vendor-card-order-btn").click({ force: true });
  await expect(page.getByTestId("parchi-sheet")).toBeVisible({ timeout: 20_000 });

  const menuToggle = page.getByRole("button", { name: /Menu/i });
  if (await menuToggle.isVisible().catch(() => false)) {
    const panel = page.getByTestId("parchi-menu-items-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await menuToggle.click();
    }
  }
  await expect(page.getByTestId("parchi-menu-items-panel")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: new RegExp(`Increase ${itemName}`) }).click();

  await expect(page.getByTestId("parchi-min-delivery-subtotal")).toContainText("₹50");
  await expect(page.getByTestId("parchi-min-delivery-need")).toBeVisible();
  await expect(page.getByTestId("parchi-submit-btn")).toBeDisabled();

  await page.getByRole("button", { name: /Add to order/i }).click();
  await expect(page.getByTestId("parchi-min-delivery-subtotal")).toContainText("₹50");
  await expect(page.getByTestId("parchi-submit-btn")).toBeDisabled();

  if (!(await page.getByTestId("parchi-menu-items-panel").isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Menu/i }).click();
  }
  const plus = page.getByRole("button", { name: new RegExp(`Increase ${itemName}`) });
  await plus.click();
  await plus.click();
  await plus.click();

  await expect(page.getByTestId("parchi-min-delivery-subtotal")).toContainText("₹200");
  await expect(page.getByTestId("parchi-min-delivery-need")).toHaveCount(0);
  await expect(page.getByTestId("parchi-submit-btn")).toBeEnabled();

  const addr = page.getByTestId("parchi-address-input");
  if (await addr.isVisible().catch(() => false)) {
    await addr.fill("MinDel live address");
  }
  await page.getByTestId("parchi-submit-btn").click();
  await expect(page.getByTestId("parchi-sheet")).toBeHidden({ timeout: 20_000 });

  const { data: uiReq, error: uiErr } = await supabaseAdmin
    .from("requests")
    .select("id, items, message")
    .eq("vendor_id", vendor.id)
    .eq("user_phone", CUSTOMER_PHONE)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (uiErr) throw uiErr;
  expect(uiReq, "UI submit should create a request").toBeTruthy();
  createdRequestIds.push(uiReq!.id);
  expect(Array.isArray(uiReq!.items), "requests.items populated from live cart").toBe(true);
  expect(uiReq!.items).not.toBeNull();
  const qty = uiReq!.items.reduce(
    (sum: number, row: { quantity?: number }) => sum + Number(row.quantity ?? 0),
    0,
  );
  expect(qty).toBe(4);
});

test("MINDEL-NOMENU — My Business soft-warns when min is set with no priced items; save still works", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const grocery = await getActiveCategoryByServiceMode("delivery");
  const minAmount = 150;

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      name: "Min Delivery NoMenu",
      shop_name: `!MINDEL-NOMENU-${T}`,
      phone: VENDOR_NOMENU_PHONE,
      category: grocery.label,
      service_mode: "delivery",
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

  await seedVendorCategory(vendor.id, grocery, {
    is_primary: true,
    serves_at_customer_place: true,
    serves_at_vendor_place: true,
    latitude: PUNE.latitude,
    longitude: PUNE.longitude,
    service_radius_km: 9999,
    modes: ["delivery"],
  });
  await seedDefaultVendorVerification(vendor.id);

  const { count: menuCount, error: menuCountErr } = await supabaseAdmin
    .from("vendor_menu_items")
    .select("id", { count: "exact", head: true })
    .eq("vendor_id", vendor.id)
    .eq("category_id", grocery.id);
  if (menuCountErr) throw menuCountErr;
  expect(menuCount ?? 0, "seed must have no menu items").toBe(0);

  await loginAsVendor(page, VENDOR_NOMENU_PHONE, vendor.id, `${DEVICE_ID}_nomenu`);
  await page.goto(`${APP_URL}/settings`);
  await openVendorMyBusinessTab(page);
  await expandMyBusinessCategoryAccordion(page, grocery.id);

  const input = page.getByTestId(`my-business-min-delivery-${grocery.id}`);
  const saveBtn = page.getByTestId(`my-business-min-delivery-save-${grocery.id}`);
  const warning = page.getByTestId(`my-business-min-delivery-no-menu-warning-${grocery.id}`);

  await input.scrollIntoViewIfNeeded();
  await expect(input).toBeVisible({ timeout: 15_000 });
  await expect(saveBtn).toBeVisible();
  await expect(warning).toHaveCount(0);

  await input.fill(String(minAmount));
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(/no priced menu items/i);
  await expect(saveBtn).toBeEnabled();

  await saveBtn.click();
  await expect(page.getByText("Minimum order saved")).toBeVisible({ timeout: 15_000 });
  await expect(warning).toBeVisible();
  await expect(saveBtn).toBeEnabled();

  const { data: saved, error: savedErr } = await supabaseAdmin
    .from("vendor_categories")
    .select("min_delivery_order_amount")
    .eq("vendor_id", vendor.id)
    .eq("category_id", grocery.id)
    .single();
  if (savedErr) throw savedErr;
  expect(Number(saved.min_delivery_order_amount)).toBe(minAmount);
});
