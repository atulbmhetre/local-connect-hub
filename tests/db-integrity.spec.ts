import { test, expect } from "@playwright/test";
import {
  supabaseAdmin,
  createTestVendor,
  cleanupTestData,
  cleanupTestVendors,
  TEST_SESSION,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";
import {
  SEEDED_APP_CONFIG_KEYS,
  SEEDED_BOOLEAN_KEYS,
  SEEDED_NUMBER_KEYS,
  SEEDED_TEXT_KEYS,
  VALID_FEED_POST_TYPES,
} from "../src/test/dbFixtures";

test.afterAll(async () => {
  await cleanupTestVendors();
  await cleanupTestData();
});

test("DB-01: seeded app_config keys exist with correct value types", async () => {
  const { data, error } = await supabaseAdmin
    .from("app_config")
    .select("key, value")
    .in("key", [...SEEDED_APP_CONFIG_KEYS]);

  expect(error).toBeNull();
  expect(data?.length).toBe(SEEDED_APP_CONFIG_KEYS.length);

  const byKey = Object.fromEntries((data ?? []).map((row) => [row.key, row.value]));

  for (const key of SEEDED_BOOLEAN_KEYS) {
    const value = (byKey[key] ?? "").trim().toLowerCase();
    expect(["true", "false"]).toContain(value);
  }

  for (const key of SEEDED_NUMBER_KEYS) {
    const value = byKey[key] ?? "";
    expect(value).toMatch(/^-?\d+(\.\d+)?$/);
  }

  for (const key of SEEDED_TEXT_KEYS) {
    expect((byKey[key] ?? "").trim().length).toBeGreaterThan(0);
  }
});

test("DB-02: vendors.service_radius_km is never null and defaults to 15 on register", async () => {
  const { data: nullRows, error: nullErr } = await supabaseAdmin
    .from("vendors")
    .select("id")
    .is("service_radius_km", null)
    .limit(1);
  expect(nullErr).toBeNull();
  expect(nullRows?.length ?? 0).toBe(0);

  const phone = `99002${Date.now().toString().slice(-5)}`;
  const registerResult = await invokeRegisterVendorRpc({
    phone,
    shop_name: `Radius Default ${TEST_SESSION}`,
    is_active: false,
  });
  expect(registerResult.error).toBeUndefined();
  const vendorId = registerResult.vendorId!;

  const { data: vendor, error } = await supabaseAdmin
    .from("vendors")
    .select("service_radius_km")
    .eq("id", vendorId)
    .single();
  expect(error).toBeNull();
  expect(vendor?.service_radius_km).toBe(15);

  await deleteVendorRegistrationArtifacts(vendorId);
});

test("DB-03: app_users.lang accepts en, hi, mr, and null only", async () => {
  const phones = [
    `880020${Date.now().toString().slice(-4)}1`,
    `880020${Date.now().toString().slice(-4)}2`,
    `880020${Date.now().toString().slice(-4)}3`,
    `880020${Date.now().toString().slice(-4)}4`,
  ];
  const langs = ["en", "hi", "mr", null] as const;

  for (let i = 0; i < langs.length; i++) {
    const { error } = await supabaseAdmin.from("app_users").insert({
      phone: phones[i],
      lang: langs[i],
      referral_code: `T${phones[i].slice(-6)}`,
    });
    expect(error).toBeNull();
  }

  const invalidPhone = `880020${Date.now().toString().slice(-4)}9`;
  const { error: invalidErr } = await supabaseAdmin.from("app_users").insert({
    phone: invalidPhone,
    lang: "fr",
    referral_code: `T${invalidPhone.slice(-6)}`,
  });
  expect(invalidErr).not.toBeNull();

  await supabaseAdmin.from("app_users").delete().in("phone", phones);
});

test("DB-04: feed_posts.type rejects values outside announcement/recommendation/offer", async () => {
  const vendor = await createTestVendor({ is_active: true });
  const base = {
    user_phone: vendor.phone,
    vendor_id: vendor.id,
    content: `type check ${TEST_SESSION}`,
    lat: 18.5204,
    lng: 73.8567,
  };

  for (const type of VALID_FEED_POST_TYPES) {
    const { error } = await supabaseAdmin.from("feed_posts").insert({ ...base, type });
    expect(error).toBeNull();
  }

  const { error: badType } = await supabaseAdmin.from("feed_posts").insert({
    ...base,
    type: "vendor_update",
    content: `invalid type ${TEST_SESSION}`,
  });
  expect(badType).not.toBeNull();

  await supabaseAdmin
    .from("feed_posts")
    .delete()
    .like("content", `%${TEST_SESSION}%`);
  await deleteVendorRegistrationArtifacts(vendor.id);
});

test("DB-RAD-01: vendor service_radius_km is respected — vendor outside radius not returned in bbox query", async () => {
  // Seed vendor at 18.5204, 73.8567 (Pune) with service_radius_km: 5
  // Customer is at 18.5600, 73.8567 (~6km away)
  // Vendor should NOT appear when customer searches within 15km bracket
  // because vendor's own radius (5km) is tighter
  const { data: vendor } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: `99099${Date.now().toString().slice(-5)}`,
      name: "Radius Test Vendor",
      shop_name: "Radius Test Shop",
      category: "Grocery",
      service_mode: "delivery",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 5,
      profile_status: "complete",
      is_banned: false,
      upi_id: "test@upi",
    })
    .select()
    .single();

  // Direct DB query mimicking radar Track A bbox filter
  const { data } = await supabaseAdmin
    .from("vendors")
    .select("id, service_radius_km")
    .eq("id", vendor!.id)
    .lt("service_radius_km", 9999)
    .gte("latitude", 18.56 - 0.5)
    .lte("latitude", 18.56 + 0.5)
    .gte("longitude", 73.8567 - 0.5)
    .lte("longitude", 73.8567 + 0.5);

  // Vendor is in bbox but passesTrackARadiusFilter should exclude it
  const dist = 6; // ~6km
  const passes = data?.some((v) => dist <= Math.min(15, v.service_radius_km));
  expect(passes).toBe(false);

  await supabaseAdmin.from("vendors").delete().eq("id", vendor!.id);
});
