import { expect } from "@playwright/test";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByServiceMode,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
  vendorPhoneById,
} from "./setup";

export type Mode = "help" | "delivery" | "appointment";

export type PauseIds = {
  vendorIds: string[];
  phones: string[];
  requestIds: string[];
  authUserIds: string[];
};

export function emptyPauseIds(): PauseIds {
  return { vendorIds: [], phones: [], requestIds: [], authUserIds: [] };
}

export async function cleanupPauseIds(ids: PauseIds): Promise<void> {
  for (const id of ids.vendorIds) {
    await supabaseAdmin.from("recurring_orders").delete().eq("vendor_id", id);
    const { data: reqs } = await supabaseAdmin.from("requests").select("id").eq("vendor_id", id);
    const reqIds = (reqs ?? []).map((r) => r.id as string);
    if (reqIds.length) {
      await supabaseAdmin.from("order_items").delete().in("request_id", reqIds);
      await supabaseAdmin.from("order_bills").delete().in("request_id", reqIds);
      await supabaseAdmin.from("khata_transactions").delete().in("request_id", reqIds);
      await supabaseAdmin.from("requests").delete().in("id", reqIds);
    }
    await supabaseAdmin.from("vendor_billing_pauses").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_pause_events").delete().eq("vendor_id", id);
    await supabaseAdmin.from("khata_ledger").delete().eq("vendor_id", id);
    await supabaseAdmin.from("khata_transactions").delete().eq("vendor_id", id);
    await supabaseAdmin.from("saved_vendors").delete().eq("vendor_id", id);
    await deleteVendorRegistrationArtifacts(id);
  }
  if (ids.phones.length) {
    await supabaseAdmin.from("user_notifications").delete().in("user_phone", ids.phones);
    await supabaseAdmin.from("users").delete().in("phone", ids.phones);
  }
  for (const uid of ids.authUserIds) {
    await supabaseAdmin.auth.admin.deleteUser(uid);
  }
}

export function nextPhone(ids: PauseIds, prefix: string, t: number): string {
  const phone = `${prefix}${String(t + ids.phones.length + 1).slice(-5)}`;
  ids.phones.push(phone);
  return phone;
}

export async function seedPauseVendor(
  ids: PauseIds,
  t: number,
  opts: {
    shop: string;
    modes: Mode[];
    prefix?: string;
    subscription_status?: string | null;
  },
) {
  const cats = [];
  for (const mode of opts.modes) {
    cats.push(await getActiveCategoryByServiceMode(mode));
  }
  const vendorPhone = nextPhone(ids, opts.prefix ?? "99081", t);
  const row: Record<string, unknown> = {
    phone: vendorPhone,
    name: "Pause Coverage Vendor",
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
    trial_ends_at: new Date(Date.now() + 20 * 86_400_000).toISOString(),
  };
  if (opts.subscription_status === null) {
    row.subscription_status = null;
  } else {
    row.subscription_status = opts.subscription_status ?? "trial";
  }
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert(row)
    .select("id, phone, shop_name, created_at")
    .single();
  expect(error, error?.message).toBeNull();
  ids.vendorIds.push(vendor!.id);
  for (let i = 0; i < cats.length; i++) {
    await seedVendorCategory(vendor!.id, cats[i], {
      is_primary: i === 0,
      modes: [opts.modes[i]],
    });
  }
  return { vendor: vendor!, cats };
}

export async function insertRequest(
  ids: PauseIds,
  t: number,
  opts: {
    vendorId: string;
    categoryId: string;
    serviceMode: Mode;
    status: string;
    appointmentStatus?: string | null;
    appointmentTime?: string | null;
    paymentStatus?: string | null;
    message?: string;
  },
) {
  const customerPhone = nextPhone(ids, "88081", t);
  await supabaseAdmin.from("users").upsert({ phone: customerPhone, trust_score: 75 }, { onConflict: "phone" });
  const { data, error } = await supabaseAdmin
    .from("requests")
    .insert({
      device_id: `pbc-${t}-${ids.requestIds.length}`,
      vendor_id: opts.vendorId,
      message: opts.message ?? `pbc-${opts.serviceMode}-${opts.status}`,
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
  ids.requestIds.push(data!.id);
  return { requestId: data!.id, customerPhone };
}

export async function pauseRpc(vendorId: string, categoryId: string, paused: boolean) {
  const phone = await vendorPhoneById(vendorId);
  return supabase.rpc("vendor_update_category_profile", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_category_id: categoryId,
    p_patch: { is_paused: paused },
  });
}

export async function preflight(vendorId: string, categoryId: string) {
  return supabaseAdmin.rpc("vendor_pause_preflight", {
    p_vendor_id: vendorId,
    p_category_id: categoryId,
  });
}

export async function openWindows(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id, started_at, ended_at, days, credited_days, qualified")
    .eq("vendor_id", vendorId)
    .is("ended_at", null);
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

export async function allWindows(vendorId: string) {
  const { data, error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .select("id, started_at, ended_at, days, credited_days, qualified")
    .eq("vendor_id", vendorId)
    .order("started_at", { ascending: true });
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

export async function backdateOpenStartedAt(vendorId: string, msAgo: number) {
  const open = await openWindows(vendorId);
  expect(open.length, "expected an open billing window").toBe(1);
  const { error } = await supabaseAdmin
    .from("vendor_billing_pauses")
    .update({ started_at: new Date(Date.now() - msAgo).toISOString() })
    .eq("id", open[0].id);
  expect(error, error?.message).toBeNull();
}

export async function creditDays(vendorId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("vendors")
    .select("pause_credit_days")
    .eq("id", vendorId)
    .single();
  expect(error, error?.message).toBeNull();
  return Number(data?.pause_credit_days ?? 0);
}

export function isKnownBugFk(err: { code?: string; message?: string } | null | undefined): boolean {
  const msg = err?.message ?? "";
  return err?.code === "23503" && msg.includes("user_notifications_related_id_fkey");
}
