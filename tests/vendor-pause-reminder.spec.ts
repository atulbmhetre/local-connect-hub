/**
 * Phase 4: pause reminder cron (pause_reminder_interval_days).
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
import { strings, loadStringBundle } from "../src/lib/strings";

const T = Date.now();
const createdVendorIds: string[] = [];
const createdPhones: string[] = [];

test.setTimeout(90_000);

test.beforeAll(async () => {
  await loadStringBundle("hi");
  await loadStringBundle("mr");
});

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_billing_pauses").delete().eq("vendor_id", id);
    await supabaseAdmin.from("vendor_pause_events").delete().eq("vendor_id", id);
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

async function intervalDays(): Promise<number> {
  const { data } = await supabaseAdmin
    .from("app_config")
    .select("value")
    .eq("key", "pause_reminder_interval_days")
    .maybeSingle();
  const n = Number.parseInt(String(data?.value ?? "30"), 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

async function seedAccount(opts: {
  shop: string;
  modes: Array<"help" | "delivery" | "appointment">;
}) {
  const cats = [];
  for (const mode of opts.modes) {
    cats.push(await getActiveCategoryByServiceMode(mode));
  }
  const vendorPhone = nextPhone("99074");
  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "Pause Reminder Vendor",
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
    .select("id, phone")
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

async function pauseRpc(vendorId: string, categoryId: string, paused: boolean) {
  const phone = await vendorPhoneById(vendorId);
  return supabase.rpc("vendor_update_category_profile", {
    p_vendor_id: vendorId,
    p_vendor_phone: phone,
    p_category_id: categoryId,
    p_patch: { is_paused: paused },
  });
}

async function backdatePausedAt(vendorId: string, categoryId: string, msAgo: number) {
  const { error } = await supabaseAdmin
    .from("vendor_categories")
    .update({ paused_at: new Date(Date.now() - msAgo).toISOString() })
    .eq("vendor_id", vendorId)
    .eq("category_id", categoryId)
    .eq("is_paused", true);
  expect(error, error?.message).toBeNull();
}

/** Extra hours so client/server clock skew cannot miss `paused_at <= now() - interval`. */
function intervalElapsedMs(days: number): number {
  return days * 86_400_000 + 2 * 3_600_000;
}

async function reminderNotifs(phone: string) {
  const { data, error } = await supabaseAdmin
    .from("user_notifications")
    .select("id, type, title, body, created_at")
    .eq("user_phone", phone)
    .eq("type", "vendor_paused_reminder")
    .order("created_at", { ascending: true });
  expect(error, error?.message).toBeNull();
  return data ?? [];
}

async function sentAt(vendorId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("vendors")
    .select("pause_reminder_sent_at")
    .eq("id", vendorId)
    .single();
  expect(error, error?.message).toBeNull();
  return data?.pause_reminder_sent_at ?? null;
}

test("REMIND-01 — fires once at the interval, not again until the next interval", async () => {
  const days = await intervalDays();
  const { vendor, cats } = await seedAccount({ shop: `!PREM-ONCE-${T}`, modes: ["help"] });
  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  await backdatePausedAt(vendor.id, cats[0].id, intervalElapsedMs(days));

  const first = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(first.error, first.error?.message).toBeNull();
  expect(Number(first.data?.sent ?? 0)).toBeGreaterThanOrEqual(1);
  const notes1 = await reminderNotifs(vendor.phone);
  expect(notes1.length).toBe(1);
  expect(notes1[0].body).toContain("customers can't see you");
  expect(await sentAt(vendor.id)).toBeTruthy();

  const second = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(second.error, second.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(1);

  const { error: stampErr } = await supabaseAdmin
    .from("vendors")
    .update({
      pause_reminder_sent_at: new Date(Date.now() - intervalElapsedMs(days)).toISOString(),
    })
    .eq("id", vendor.id);
  expect(stampErr, stampErr?.message).toBeNull();

  const third = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(third.error, third.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(2);
});

test("REMIND-02 — silent when nothing is paused or pause is shorter than the interval", async () => {
  const days = await intervalDays();
  const { vendor, cats } = await seedAccount({ shop: `!PREM-SILENT-${T}`, modes: ["help"] });

  const idle = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(idle.error, idle.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(0);
  expect(await sentAt(vendor.id)).toBeNull();

  const { error: pauseErr } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(pauseErr, pauseErr?.message).toBeNull();
  await backdatePausedAt(vendor.id, cats[0].id, (days - 1) * 86_400_000);

  const early = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(early.error, early.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(0);
  expect(await sentAt(vendor.id)).toBeNull();
});

test("REMIND-03 — one notification for a vendor with several paused businesses", async () => {
  const days = await intervalDays();
  const { vendor, cats } = await seedAccount({
    shop: `!PREM-MULTI-${T}`,
    modes: ["help", "delivery"],
  });
  expect(cats.length).toBe(2);
  for (const cat of cats) {
    const { error } = await pauseRpc(vendor.id, cat.id, true);
    expect(error, error?.message).toBeNull();
    await backdatePausedAt(vendor.id, cat.id, intervalElapsedMs(days));
  }
  const { error } = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(error, error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(1);
});

test("REMIND-04 — unpaused then repaused restarts the clock", async () => {
  const days = await intervalDays();
  const { vendor, cats } = await seedAccount({ shop: `!PREM-RESET-${T}`, modes: ["help"] });
  const { error: p1 } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(p1, p1?.message).toBeNull();
  await backdatePausedAt(vendor.id, cats[0].id, intervalElapsedMs(days));
  const first = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(first.error, first.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(1);
  expect(await sentAt(vendor.id)).toBeTruthy();

  const { error: resumeErr } = await pauseRpc(vendor.id, cats[0].id, false);
  expect(resumeErr, resumeErr?.message).toBeNull();
  expect(await sentAt(vendor.id)).toBeNull();

  const { error: p2 } = await pauseRpc(vendor.id, cats[0].id, true);
  expect(p2, p2?.message).toBeNull();
  const again = await supabaseAdmin.rpc("remind_paused_vendors");
  expect(again.error, again.error?.message).toBeNull();
  expect(await reminderNotifs(vendor.phone)).toHaveLength(1);
  expect(await sentAt(vendor.id)).toBeNull();
});

test("REMIND-05 — vendor cannot write pause_reminder_sent_at; EN/HI/MR copy keys exist", async () => {
  const { vendor } = await seedAccount({ shop: `!PREM-GUARD-${T}`, modes: ["help"] });
  const phone = await vendorPhoneById(vendor.id);
  const { error } = await supabase.rpc("vendor_update_own", {
    p_vendor_id: vendor.id,
    p_vendor_phone: phone,
    p_patch: { pause_reminder_sent_at: new Date().toISOString() },
  });
  expect(error?.message ?? "").toContain("field_not_allowed");
  expect(await sentAt(vendor.id)).toBeNull();

  const { data: rows, error: i18nErr } = await supabaseAdmin
    .from("notification_i18n")
    .select("lang, title, body")
    .eq("copy_key", "vendor_paused_reminder");
  expect(i18nErr, i18nErr?.message).toBeNull();
  const byLang = Object.fromEntries((rows ?? []).map((r) => [r.lang, r]));
  expect(byLang.en?.body).toBe(strings.en.vendor_pause_reminder_body);
  expect(byLang.hi?.body).toBe(strings.hi.vendor_pause_reminder_body);
  expect(byLang.mr?.body).toBe(strings.mr.vendor_pause_reminder_body);
  expect(String(byLang.hi?.body)).toContain("व्यवसाय");
  expect(String(byLang.hi?.body)).not.toMatch(/धंधा/);
  expect(strings.hi.vendor_pause_reminder_body).not.toBe(strings.en.vendor_pause_reminder_body);
  expect(strings.mr.vendor_pause_reminder_body).not.toBe(strings.en.vendor_pause_reminder_body);
});
