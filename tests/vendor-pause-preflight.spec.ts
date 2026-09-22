/**
 * Pause preflight / open-work gate / history / recurring skip notice.
 */
import { test, expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
  vendorPhoneById,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];
const createdRequestIds: string[] = [];

test.setTimeout(90_000);

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("recurring_orders").delete().eq("vendor_id", id);
    const { data: reqs } = await supabaseAdmin.from("requests").select("id").eq("vendor_id", id);
    const ids = (reqs ?? []).map((r) => r.id as string);
    if (ids.length) {
      await supabaseAdmin.from("order_items").delete().in("request_id", ids);
      await supabaseAdmin.from("order_bills").delete().in("request_id", ids);
      await supabaseAdmin.from("payment_dispute_events").delete().eq("vendor_id", id);
      await supabaseAdmin.from("vendor_reviews").delete().in("request_id", ids);
      await supabaseAdmin.from("khata_transactions").delete().in("request_id", ids);
      const { error: reqDel } = await supabaseAdmin.from("requests").delete().in("id", ids);
      if (reqDel) throw new Error(`cleanup requests: ${reqDel.message}`);
    }
    await supabaseAdmin.from("vendor_pause_events").delete().eq("vendor_id", id);
    await supabaseAdmin.from("khata_ledger").delete().eq("vendor_id", id);
    await supabaseAdmin.from("khata_transactions").delete().eq("vendor_id", id);
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

async function seedAccount(opts: {
  shop: string;
  modes: Array<"help" | "delivery" | "appointment">;
}) {
  const cats = [];
  for (const mode of opts.modes) {
    cats.push(await getActiveCategoryByServiceMode(mode));
  }
  const vendorPhone = nextPhone("99071");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Pause Gate Vendor",
      shop_name: opts.shop,
      category: cats[0].label,
      service_mode: opts.modes[0],
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
    .select("id, phone, shop_name")
    .single();
  expect(error, error?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  for (let i = 0; i < cats.length; i++) {
    await seedVendorCategory(vendor!.id, cats[i], {
      is_primary: i === 0,
      modes: [opts.modes[i]],
    });
  }
  return { vendor: vendor!, cats };
}

async function insertOpenRequest(opts: {
  vendorId: string;
  categoryId: string;
  serviceMode: "help" | "delivery" | "appointment";
  status: "sent" | "seen" | "accepted";
  appointmentStatus?: string | null;
  appointmentTime?: string | null;
  paymentStatus?: string | null;
}) {
  const customerPhone = nextPhone("88071");
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data, error } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: `pause-${T}-${createdRequestIds.length}`,
      vendor_id: opts.vendorId,
      message: `pause-open-${opts.serviceMode}`,
      user_phone: customerPhone,
      status: opts.status,
      category_id: opts.categoryId,
      service_mode: opts.serviceMode,
      appointment_status: opts.appointmentStatus ?? null,
      appointment_time: opts.appointmentTime ?? null,
      payment_status: opts.paymentStatus ?? "unpaid",
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  createdRequestIds.push(data!.id);
  return { requestId: data!.id, customerPhone };
}

async function pauseRpc(vendorId: string, categoryId: string, paused: boolean) {
  const phone = await vendorPhoneById(vendorId);
  return supabase.rpc("vendor_update_category_profile", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_category_id: categoryId,
    p_patch: { is_paused: paused },
  });
}

test("PAUSE-01 — refused with open Help (unaccepted sent)", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-HELP-${T}`, modes: ["help"] });
  await insertOpenRequest({
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error?.message ?? "").toMatch(/pause_blocked_open_work/);
  expect(error?.details ?? "").toMatch(/help/);
  const { data: pre } = await supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(pre?.can_pause).toBe(false);
  expect(pre?.block_reason).toBe("open_work");
  expect(pre?.open_work?.help).toBeGreaterThanOrEqual(1);
});

test("PAUSE-02 — refused with open Delivery (accepted)", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-DEL-${T}`, modes: ["delivery"] });
  await insertOpenRequest({
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "delivery",
    status: "accepted",
  });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error?.message ?? "").toMatch(/pause_blocked_open_work/);
});

test("PAUSE-03 — refused with future confirmed appointment", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-APPT-${T}`, modes: ["appointment"] });
  const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  await insertOpenRequest({
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "appointment",
    status: "accepted",
    appointmentStatus: "confirmed",
    appointmentTime: future,
  });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error?.message ?? "").toMatch(/pause_blocked_open_work/);
  expect(error?.details ?? "").toMatch(/appointment/);
});

test("PAUSE-04 — allowed at zero open work; history row written", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-ZERO-${T}`, modes: ["help"] });
  const { error } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(error, error?.message).toBeNull();
  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("is_paused, paused_at")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .single();
  expect(vc?.is_paused).toBe(true);
  expect(vc?.paused_at).toBeTruthy();
  const { data: events } = await supabaseAdmin
    .from("vendor_pause_events")
    .select("paused_at, resumed_at")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  expect(events?.length).toBeGreaterThanOrEqual(1);
  expect(events?.some((e) => e.resumed_at == null)).toBe(true);
});

test("PAUSE-05 — refused when subscription is grace or expired", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-SUB-${T}`, modes: ["help"] });
  await supabaseAdmin.from("vendors").update({ subscription_status: "grace" }).eq("id", vendor.id);
  const grace = await pauseRpc(vendor.id, cats[0].id, true);
  expect(grace.error?.message ?? "").toMatch(/pause_blocked_subscription/);
  await supabaseAdmin.from("vendors").update({ subscription_status: "expired" }).eq("id", vendor.id);
  const expired = await pauseRpc(vendor.id, cats[0].id, true);
  expect(expired.error?.message ?? "").toMatch(/pause_blocked_subscription/);
  const { data: pre } = await supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: vendor.id,
    p_category_id: cats[0].id,
  });
  expect(pre?.can_pause).toBe(false);
  expect(pre?.block_reason).toBe("subscription_state");
});

test("PAUSE-06 — resume always allowed even with open work and grace", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-RES-${T}`, modes: ["help"] });
  await supabaseAdmin
    .from("vendor_categories")
    .update({ is_paused: true })
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id);
  await insertOpenRequest({
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  await supabaseAdmin.from("vendors").update({ subscription_status: "grace" }).eq("id", vendor.id);
  const { error } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(error, error?.message).toBeNull();
  const { data: vc } = await supabaseAdmin
    .from("vendor_categories")
    .select("is_paused, paused_at")
    .eq("vendor_id", vendor.id)
    .eq("category_id", cats[0].id)
    .single();
  expect(vc?.is_paused).toBe(false);
  expect(vc?.paused_at).toBeNull();
});

test("PAUSE-07 — paused vendor can record khata payment and confirm/dispute UPI", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-PAY-${T}`, modes: ["delivery"] });
  const customerPhone = nextPhone("88072");
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();

  await supabaseAdmin.from("khata_ledger").insert({
    vendor_id: vendor.id,
    user_phone: customerPhone,
    total_outstanding: 200,
  });
  const { error: khataErr } = await supabase.rpc("vendor_record_khata_payment", {
    p_vendor_id: vendor.id,
    p_vendor_phone: vendor.phone,
    p_customer_phone: customerPhone,
    p_amount: 50,
    p_note: "pause-pay",
  });
  expect(khataErr, khataErr?.message).toBeNull();

  const { data: confirmReq, error: cIns } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: `pause-upi-c-${T}`,
      vendor_id: vendor.id,
      message: "upi confirm while paused",
      user_phone: customerPhone,
      status: "fulfilled",
      category_id: cats[0].id,
      service_mode: "delivery",
      payment_status: "claimed",
      payment_utr: "123456789012",
    })
    .select("id")
    .single();
  expect(cIns, cIns?.message).toBeNull();
  createdRequestIds.push(confirmReq!.id);
  await supabaseAdmin.from("order_bills").insert({
    request_id: confirmReq!.id,
    vendor_id: vendor.id,
    user_phone: customerPhone,
    total_amount: 80,
    payment_mode: "upi",
    payment_status: "unpaid",
  });
  const { error: confirmErr } = await supabase.rpc("confirm_upi_payment", {
    p_request_id: confirmReq!.id,
    p_vendor_phone: vendor.phone,
  });
  expect(confirmErr, confirmErr?.message).toBeNull();

  const { data: disputeReq, error: dIns } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: `pause-upi-d-${T}`,
      vendor_id: vendor.id,
      message: "upi dispute while paused",
      user_phone: customerPhone,
      status: "fulfilled",
      category_id: cats[0].id,
      service_mode: "delivery",
      payment_status: "claimed",
      payment_utr: "123456789013",
    })
    .select("id")
    .single();
  expect(dIns, dIns?.message).toBeNull();
  createdRequestIds.push(disputeReq!.id);
  const { error: disputeErr } = await supabase.rpc("dispute_upi_payment", {
    p_request_id: disputeReq!.id,
    p_vendor_phone: vendor.phone,
  });
  expect(disputeErr, disputeErr?.message).toBeNull();
});

test("PAUSE-08 — pause judged only by that business's work", async () => {
  const { vendor, cats } = await seedAccount({
    shop: `!PAUSE-TWO-${T}`,
    modes: ["help", "delivery"],
  });
  await insertOpenRequest({
    vendorId: vendor.id,
    categoryId: cats[0].id,
    serviceMode: "help",
    status: "sent",
  });
  const blocked = await pauseRpc(vendor.id, cats[0].id, true);
  expect(blocked.error?.message ?? "").toMatch(/pause_blocked_open_work/);
  const other = await pauseRpc(vendor.id, cats[1].id, true);
  expect(other.error, other.error?.message).toBeNull();
  const { data: pre } = await supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: vendor.id,
    p_category_id: cats[1].id,
  });
  expect(pre?.open_work?.help).toBe(0);
  expect(pre?.will_freeze_billing).toBe(false);
});

test("PAUSE-09 — skipped recurring run notifies once; flag clears after success", async () => {
  const { vendor, cats } = await seedAccount({ shop: `!PAUSE-REC-${T}`, modes: ["delivery"] });
  const customerPhone = nextPhone("88073");
  const deviceId = `pause-rec-${T}`;
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });

  const { data: firstId, error: createErr } = await supabase.rpc("create_recurring_order", {
    p_device_id: deviceId,
    p_vendor_id: vendor.id,
    p_message: "Daily pause skip",
    p_interval_kind: "daily",
    p_user_phone: customerPhone,
    p_device_id_log: deviceId,
    p_delivery_address: "Pune test",
    p_delivery_slot: "evening",
    p_delivery_slot_deadline: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    p_category_id: cats[0].id,
    p_service_mode: "delivery",
  });
  expect(createErr, createErr?.message).toBeNull();
  createdRequestIds.push(firstId as string);

  const { data: firstReq } = await supabaseAdmin
    .from("requests")
    .select("recurring_order_id")
    .eq("id", firstId as string)
    .single();
  const parentId = firstReq!.recurring_order_id as string;

  await supabaseAdmin.from("requests").update({ status: "done" }).eq("id", firstId as string);

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();

  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parentId);
  const spawn1 = await supabaseAdmin.rpc("spawn_due_recurring_orders");
  expect(spawn1.error, spawn1.error?.message).toBeNull();

  const { data: notes1 } = await supabaseAdmin
    .from("user_notifications")
    .select("id, body, type")
    .eq("user_phone", customerPhone)
    .eq("type", "recurring_skipped_paused");
  expect(notes1?.length).toBe(1);
  expect(notes1![0].body ?? "").toMatch(/on a break|skipped/i);

  const { data: parent1 } = await supabaseAdmin
    .from("recurring_orders")
    .select("skip_notified_at, status")
    .eq("id", parentId)
    .single();
  expect(parent1?.status).toBe("active");
  expect(parent1?.skip_notified_at).toBeTruthy();

  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parentId);
  await supabaseAdmin.rpc("spawn_due_recurring_orders");
  const { data: notes2 } = await supabaseAdmin
    .from("user_notifications")
    .select("id")
    .eq("user_phone", customerPhone)
    .eq("type", "recurring_skipped_paused");
  expect(notes2?.length).toBe(1);

  await pauseRpc(vendor.id, cats[0].id, false);
  await supabaseAdmin
    .from("recurring_orders")
    .update({ next_run_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", parentId);
  const spawnOk = await supabaseAdmin.rpc("spawn_due_recurring_orders");
  expect(spawnOk.error, spawnOk.error?.message).toBeNull();
  expect(Number(spawnOk.data)).toBeGreaterThanOrEqual(1);

  const { data: spawnedKids } = await supabaseAdmin
    .from("requests")
    .select("id")
    .eq("recurring_order_id", parentId);
  for (const row of spawnedKids ?? []) createdRequestIds.push(row.id as string);

  const { data: parent2 } = await supabaseAdmin
    .from("recurring_orders")
    .select("skip_notified_at")
    .eq("id", parentId)
    .single();
  expect(parent2?.skip_notified_at).toBeNull();
});
