/**
 * Server-only vendor notify after MyOrders client invokeNotifyVendor removal.
 * Inbox is written by trg_notify_on_request_lifecycle / category / referral triggers.
 */
import { test, expect } from "@playwright/test";
import {
  supabaseAdmin,
  createTestVendor,
  deleteVendorRegistrationArtifacts,
  generateUniqueVendorPhone,
  resolveRequestServiceMode,
} from "./helpers/setup";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdRequestIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdReferralIds: string[] = [];
const createdPhones: string[] = [];

const COPY = {
  dismissedTitleEn: "Customer marked order as done",
  dismissedBodyEn: "The customer has marked this order as done on their end",
  cancelledTitleEn: "Order cancelled by customer",
  cancelledBodyEn: "The customer has cancelled their order",
  cancelledTitleHi: "ग्राहक ने ऑर्डर रद्द किया",
  cancelledBodyHi: "ग्राहक ने अपना ऑर्डर रद्द कर दिया है",
  dismissedTitleHi: "ग्राहक ने ऑर्डर पूर्ण चिह्नित किया",
} as const;

test.setTimeout(90_000);

test.afterAll(async () => {
  if (createdRequestIds.length) {
    await supabaseAdmin.from("order_bills").delete().in("request_id", createdRequestIds);
    await supabaseAdmin.from("requests").delete().in("id", createdRequestIds);
  }
  if (createdReferralIds.length) {
    await supabaseAdmin.from("vendor_credits").delete().in("referral_id", createdReferralIds);
    await supabaseAdmin.from("referrals").delete().in("id", createdReferralIds);
  }
  if (createdCategoryIds.length) {
    await supabaseAdmin.from("category_search_terms").delete().in("category_id", createdCategoryIds);
    await supabaseAdmin.from("categories").delete().in("id", createdCategoryIds);
  }
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
  if (createdPhones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", createdPhones);
    await supabaseAdmin.from("app_users").delete().in("phone", createdPhones);
    await supabaseAdmin.from("users").delete().in("phone", createdPhones);
  }
});

async function seedVendor(tag: string, serviceMode: "help" | "delivery" | "appointment") {
  const phone = generateUniqueVendorPhone();
  createdPhones.push(phone);
  const vendor = await createTestVendor({
    phone,
    shop_name: `!LNS-${tag}-${T}`,
    service_mode: serviceMode,
    category_service_modes: [serviceMode],
    availability_modes: [serviceMode],
  });
  createdVendorIds.push(vendor.id);
  return vendor as { id: string; phone: string };
}

async function seedCustomer(phone: string) {
  createdPhones.push(phone);
  const { error: u } = await supabaseAdmin
    .from("users")
    .upsert({ phone, trust_score: 75 }, { onConflict: "phone" });
  if (u) throw u;
}

async function seedRequest(
  vendorId: string,
  customerPhone: string,
  deviceId: string,
  fields: Record<string, unknown>,
) {
  const service_mode = await resolveRequestServiceMode(
    vendorId,
    typeof fields.service_mode === "string" ? fields.service_mode : null,
  );
  const { data, error } = await supabaseAdmin
    .from("requests")
    .insert({
      vendor_id: vendorId,
      user_phone: customerPhone,
      device_id: deviceId,
      message: `lns ${T}`,
      status: "sent",
      ...fields,
      service_mode,
    })
    .select("id")
    .single();
  if (error) throw error;
  createdRequestIds.push(data.id);
  return data.id as string;
}

async function vendorNotifs(vendorPhone: string, requestId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_notifications")
    .select("id, title, body, type, route, route_params, related_id")
    .eq("user_phone", vendorPhone)
    .eq("type", "order_update");
  if (error) throw error;
  return (data ?? []).filter((row) => {
    const params = row.route_params as { order_id?: string } | null;
    return params?.order_id === requestId || row.related_id === requestId;
  });
}

test("LNS-01 — engaged dismiss_order: exactly one dismissed notify in vendor lang", async () => {
  const vendor = await seedVendor("01", "delivery");
  const customer = `88001${String(T).slice(-5)}`;
  const device = `dev_lns01_${T}`;
  await seedCustomer(customer);
  await supabaseAdmin.from("app_users").upsert({ phone: vendor.phone, lang: "hi" }, { onConflict: "phone" });
  const requestId = await seedRequest(vendor.id, customer, device, {
    status: "accepted",
    service_mode: "delivery",
    delivery_slot: "morning",
  });

  const { error } = await supabaseAdmin.rpc("dismiss_order", {
    p_request_id: requestId,
    p_device_id: device,
    p_user_phone: customer,
    p_appointment_status: null,
  });
  expect(error, error?.message).toBeNull();

  const rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe("order_update");
  expect(rows[0].title).toBe(COPY.dismissedTitleHi);
  expect(rows[0].route).toBe("vendor");
  expect(rows[0].related_id).toBe(requestId);
});

test("LNS-02 — engaged cancel_customer_order: exactly one cancelled notify", async () => {
  const vendor = await seedVendor("02", "help");
  const customer = `88002${String(T).slice(-5)}`;
  const device = `dev_lns02_${T}`;
  await seedCustomer(customer);
  const requestId = await seedRequest(vendor.id, customer, device, {
    status: "accepted",
    service_mode: "help",
  });

  const { error } = await supabaseAdmin.rpc("cancel_customer_order", {
    p_request_id: requestId,
    p_device_id: device,
    p_user_phone: customer,
  });
  expect(error, error?.message).toBeNull();

  const rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe(COPY.cancelledTitleEn);
  expect(rows[0].body).toBe(COPY.cancelledBodyEn);
});

test("LNS-03 — appointment cancel: exactly one cancelled notify", async () => {
  const vendor = await seedVendor("03", "appointment");
  const customer = `88003${String(T).slice(-5)}`;
  const device = `dev_lns03_${T}`;
  await seedCustomer(customer);
  const requestId = await seedRequest(vendor.id, customer, device, {
    status: "accepted",
    service_mode: "appointment",
    appointment_time: new Date(Date.now() + 86400000).toISOString(),
    appointment_status: "confirmed",
  });

  const { error } = await supabaseAdmin.rpc("dismiss_order", {
    p_request_id: requestId,
    p_device_id: device,
    p_user_phone: customer,
    p_appointment_status: "cancelled",
  });
  expect(error, error?.message).toBeNull();

  const rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe(COPY.cancelledTitleEn);
  expect(rows[0].title).not.toBe(COPY.dismissedTitleEn);
});

test("LNS-04 — edit_customer_order: exactly one order_update", async () => {
  const vendor = await seedVendor("04", "delivery");
  const customer = `88004${String(T).slice(-5)}`;
  const device = `dev_lns04_${T}`;
  await seedCustomer(customer);
  const requestId = await seedRequest(vendor.id, customer, device, {
    status: "sent",
    service_mode: "delivery",
    message: "original milk",
  });

  const { error } = await supabaseAdmin.rpc("edit_customer_order", {
    p_request_id: requestId,
    p_message: "original milk plus bread",
    p_previous_message: "original milk",
    p_device_id: device,
    p_user_phone: customer,
  });
  expect(error, error?.message).toBeNull();

  const rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0].type).toBe("order_update");
  expect(rows[0].title).toMatch(/edited/i);
});

test("LNS-05 — already-cancelled appointment completing to done uses cancelled copy once", async () => {
  const vendor = await seedVendor("05", "appointment");
  const customer = `88005${String(T).slice(-5)}`;
  const device = `dev_lns05_${T}`;
  await seedCustomer(customer);
  const requestId = await seedRequest(vendor.id, customer, device, {
    status: "accepted",
    service_mode: "appointment",
    appointment_time: new Date(Date.now() + 86400000).toISOString(),
    appointment_status: "cancelled",
  });

  const first = await supabaseAdmin.rpc("dismiss_order", {
    p_request_id: requestId,
    p_device_id: device,
    p_user_phone: customer,
    p_appointment_status: "cancelled",
  });
  expect(first.error, first.error?.message).toBeNull();

  let rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe(COPY.cancelledTitleEn);
  expect(rows[0].title).not.toBe(COPY.dismissedTitleEn);

  const second = await supabaseAdmin.rpc("dismiss_order", {
    p_request_id: requestId,
    p_device_id: device,
    p_user_phone: customer,
    p_appointment_status: "cancelled",
  });
  expect(second.error, second.error?.message).toBeNull();
  rows = await vendorNotifs(vendor.phone, requestId);
  expect(rows).toHaveLength(1);
});

test("LNS-06 — category review related_id is null; route_params keep category_id", async () => {
  const vendor = await seedVendor("06", "help");
  const { data: cat, error: insErr } = await supabaseAdmin
    .from("categories")
    .insert({
      label: `LNS Cat ${T}`,
      emoji: "🧪",
      service_mode: "help",
      is_active: false,
      pending_review: true,
      status: "pending_review",
      suggested_by_vendor_id: vendor.id,
    })
    .select("id")
    .single();
  expect(insErr, insErr?.message).toBeNull();
  createdCategoryIds.push(cat!.id);

  const { error } = await supabaseAdmin
    .from("categories")
    .update({ status: "active", is_active: true, pending_review: false })
    .eq("id", cat!.id);
  expect(error, error?.message).toBeNull();

  const { data, error: nErr } = await supabaseAdmin
    .from("user_notifications")
    .select("id, type, related_id, route_params")
    .eq("user_phone", vendor.phone)
    .eq("type", "category_approved")
    .order("created_at", { ascending: false })
    .limit(5);
  expect(nErr, nErr?.message).toBeNull();
  const row = (data ?? []).find(
    (n) => (n.route_params as { category_id?: string } | null)?.category_id === cat!.id,
  );
  expect(row, "category_approved inbox row").toBeTruthy();
  expect(row!.related_id).toBeNull();
  expect((row!.route_params as { category_id: string }).category_id).toBe(cat!.id);
});

test("LNS-07 — referral credit related_id is null; route_params keep referral_id", async () => {
  const vendor = await seedVendor("07", "help");
  const customer = `88007${String(T).slice(-5)}`;
  await seedCustomer(customer);
  const { data: referral, error: refErr } = await supabaseAdmin
    .from("referrals")
    .insert({
      referrer_vendor_id: vendor.id,
      referee_type: "user",
      referee_id: customer,
      status: "active",
      trigger_rule: "active_once",
      credits_created: true,
    })
    .select("id")
    .single();
  expect(refErr, refErr?.message).toBeNull();
  createdReferralIds.push(referral!.id);

  const { error } = await supabaseAdmin.from("vendor_credits").insert({
    vendor_id: vendor.id,
    referral_id: referral!.id,
    amount: 2.5,
    disbursement_month: 1,
    disbursed: false,
  });
  expect(error, error?.message).toBeNull();

  const { data, error: nErr } = await supabaseAdmin
    .from("user_notifications")
    .select("id, type, related_id, route_params")
    .eq("user_phone", vendor.phone)
    .eq("type", "referral_credit")
    .order("created_at", { ascending: false })
    .limit(5);
  expect(nErr, nErr?.message).toBeNull();
  const row = (data ?? []).find(
    (n) => (n.route_params as { referral_id?: string } | null)?.referral_id === referral!.id,
  );
  expect(row, "referral_credit inbox row").toBeTruthy();
  expect(row!.related_id).toBeNull();
  expect((row!.route_params as { referral_id: string }).referral_id).toBe(referral!.id);
});
