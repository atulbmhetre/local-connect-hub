/**
 * Addendum 1: register / add-second-business / approve-reject via real RPCs.
 * KNOWN-BUG-FK: notification related_id → requests.
 */
import { test, expect } from "@playwright/test";
import {
  supabaseAdmin,
  invokeRegisterVendorRpc,
  getActiveCategoryByServiceMode,
  deleteVendorRegistrationArtifacts,
  generateUniqueVendorPhone,
} from "./helpers/setup";
import { getAdminSessionClient, ensureTestAdminUser } from "./helpers/browser-setup";
import { isKnownBugFk, openWindows } from "./helpers/pauseBillingHarness";

const T = Date.now();
const createdVendorIds: string[] = [];
test.setTimeout(120_000);
test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_billing_pauses").delete().eq("vendor_id", id);
    await deleteVendorRegistrationArtifacts(id);
  }
});

test("REG-PAUSE-01 — register_vendor creates rows and opens no billing window", async () => {
  const help = await getActiveCategoryByServiceMode("help");
  const phone = generateUniqueVendorPhone();
  const res = await invokeRegisterVendorRpc({
    phone,
    shop_name: `!REG-PAUSE-${T}`,
    category_ids: [help.id],
    category_service_modes: ["help"],
    service_mode: "help",
  });
  expect(res.error, res.error?.message).toBeFalsy();
  expect(res.vendorId).toBeTruthy();
  createdVendorIds.push(res.vendorId!);
  const { data: rows } = await supabaseAdmin
    .from("vendor_categories")
    .select("id, status")
    .eq("vendor_id", res.vendorId!);
  expect((rows ?? []).length).toBeGreaterThanOrEqual(1);
  expect((await openWindows(res.vendorId!)).length).toBe(0);
});

test("REG-PAUSE-02 — add second business RPC; pending-only still no window; approve second of a paused account closes it", async () => {
  const help = await getActiveCategoryByServiceMode("help");
  const delivery = await getActiveCategoryByServiceMode("delivery");
  const phone = generateUniqueVendorPhone();
  const res = await invokeRegisterVendorRpc({
    phone,
    shop_name: `!REG-PAUSE2-${T}`,
    category_ids: [help.id],
    category_service_modes: ["help"],
    service_mode: "help",
  });
  expect(res.error, res.error?.message).toBeFalsy();
  const vendorId = res.vendorId!;
  createdVendorIds.push(vendorId);

  await supabaseAdmin
    .from("vendor_categories")
    .update({ status: "approved", is_paused: true })
    .eq("vendor_id", vendorId)
    .eq("category_id", help.id);
  await supabaseAdmin.rpc("_sync_vendor_billing_pause", { p_vendor_id: vendorId });
  expect((await openWindows(vendorId)).length).toBe(1);

  const add = await supabaseAdmin.rpc("vendor_update_categories", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_category_ids: [help.id, delivery.id],
    p_category_service_modes: ["help", "delivery"],
    p_category_modes: { [help.id]: ["help"], [delivery.id]: ["delivery"] },
  });
  expect(add.error, add.error?.message).toBeNull();

  const { data: second } = await supabaseAdmin
    .from("vendor_categories")
    .select("id, status")
    .eq("vendor_id", vendorId)
    .eq("category_id", delivery.id)
    .single();
  expect(second).toBeTruthy();

  if (second?.status !== "approved") {
    await ensureTestAdminUser();
    const admin = await getAdminSessionClient();
    const approved = await admin.rpc("admin_approve_vendor_business", {
      p_admin_phone: "admin",
      p_vendor_category_id: second!.id,
    });
    if (isKnownBugFk(approved.error)) {
      test.fail(true, "KNOWN-BUG-FK: notification related_id is not a request id");
    }
    expect(approved.error, approved.error?.message).toBeNull();
  }

  expect((await openWindows(vendorId)).length).toBe(0);
});

test("REG-PAUSE-03 — reject-only business opens no window (KNOWN-BUG-FK expected if notify fires)", async () => {
  const help = await getActiveCategoryByServiceMode("help");
  const delivery = await getActiveCategoryByServiceMode("delivery");
  const phone = generateUniqueVendorPhone();
  const res = await invokeRegisterVendorRpc({
    phone,
    shop_name: `!REG-REJ-${T}`,
    category_ids: [help.id, delivery.id],
    category_service_modes: ["help", "delivery"],
    service_mode: "help",
  });
  expect(res.error, res.error?.message).toBeFalsy();
  const vendorId = res.vendorId!;
  createdVendorIds.push(vendorId);

  const { data: rows } = await supabaseAdmin
    .from("vendor_categories")
    .select("id, status, category_id")
    .eq("vendor_id", vendorId);
  const pending = (rows ?? []).find((r) => r.status === "pending" || r.status === "pending_review");
  if (!pending) {
    test.info().annotations.push({
      type: "skip",
      description: "register_vendor approved both rows; nothing to reject via RPC",
    });
    expect((await openWindows(vendorId)).length).toBe(0);
    return;
  }
  await ensureTestAdminUser();
  const admin = await getAdminSessionClient();
  const rejected = await admin.rpc("admin_reject_vendor_business", {
    p_admin_phone: "admin",
    p_vendor_category_id: pending.id,
    p_reason: "coverage reject",
  });
  if (isKnownBugFk(rejected.error)) {
    test.fail(true, "KNOWN-BUG-FK: notification related_id is not a request id");
  }
  expect(rejected.error, rejected.error?.message).toBeNull();
  expect((await openWindows(vendorId)).length).toBe(0);
});
