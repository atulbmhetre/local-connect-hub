/**
 * Optional per-business licenses: table, config, RPC upsert, storage path.
 * Registration remains non-blocking if license write is skipped.
 */
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  supabase,
  supabaseAdmin,
  getActiveCategoryByLabel,
  seedVendorCategory,
  deleteVendorRegistrationArtifacts,
} from "./helpers/setup";
import { getAnonKey, getSupabaseUrl } from "./helpers/testEnv";
import { LICENSE_FIELD_CATEGORIES_KEY } from "../src/lib/vendorLicenses";

const T = Date.now();
const createdVendorIds: string[] = [];

test.setTimeout(90_000);

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await supabaseAdmin.from("vendor_licenses").delete().eq("vendor_id", id);
    await deleteVendorRegistrationArtifacts(id);
  }
});

test("VL-01 — config, RPC upsert, skip-empty, and license-docs upload on TEST", async () => {
  const { data: cfg, error: cfgErr } = await supabase
    .from("app_config")
    .select("value")
    .eq("key", LICENSE_FIELD_CATEGORIES_KEY)
    .maybeSingle();
  expect(cfgErr, cfgErr?.message).toBeNull();
  expect(cfg?.value).toBeTruthy();
  const parsed = JSON.parse(String(cfg!.value)) as Record<string, string[]>;
  expect(Array.isArray(parsed.Pharmacy)).toBe(true);

  const cat = await getActiveCategoryByLabel("Pharmacy");
  const vendorPhone = `99051${String(T).slice(-5)}`;
  const { data: vendor, error: insErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: vendorPhone,
      name: "License Capture",
      shop_name: `!LIC-${T}`,
      category: cat.label,
      service_mode: cat.service_mode,
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(insErr, insErr?.message).toBeNull();
  createdVendorIds.push(vendor!.id);
  await seedVendorCategory(vendor!.id, cat, { is_primary: true });

  const { error: emptyErr } = await supabase.rpc("vendor_upsert_licenses", {
    p_vendor_id: vendor!.id,
    p_vendor_phone: vendorPhone,
    p_licenses: [{ category_id: cat.id, license_type: "drug_license" }],
  });
  expect(emptyErr, emptyErr?.message).toBeNull();
  const { data: none } = await supabaseAdmin
    .from("vendor_licenses")
    .select("id")
    .eq("vendor_id", vendor!.id);
  expect(none ?? []).toHaveLength(0);

  const path = `license-docs/${vendor!.id}/${cat.id}/drug_license_${T}.png`;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  // Service role seeds the object; anon writes are identity-scoped (see VL-02).
  const { error: upErr } = await supabaseAdmin.storage.from("vendor-docs").upload(path, png, {
    contentType: "image/png",
    upsert: true,
  });
  expect(upErr, upErr?.message).toBeNull();
  const { data: pub } = supabaseAdmin.storage.from("vendor-docs").getPublicUrl(path);

  const { error: upsertErr } = await supabase.rpc("vendor_upsert_licenses", {
    p_vendor_id: vendor!.id,
    p_vendor_phone: vendorPhone,
    p_licenses: [
      {
        category_id: cat.id,
        license_type: "drug_license",
        license_number: "MH-DRUG-12345",
        photo_url: pub.publicUrl,
      },
    ],
  });
  expect(upsertErr, upsertErr?.message).toBeNull();

  const { data: row } = await supabaseAdmin
    .from("vendor_licenses")
    .select("license_type, license_number, photo_url, category_id")
    .eq("vendor_id", vendor!.id)
    .single();
  expect(row?.license_type).toBe("drug_license");
  expect(row?.license_number).toBe("MH-DRUG-12345");
  expect(row?.category_id).toBe(cat.id);
  expect(String(row?.photo_url ?? "")).toContain("license-docs/");

  const { error: badPhone } = await supabase.rpc("vendor_upsert_licenses", {
    p_vendor_id: vendor!.id,
    p_vendor_phone: "0000000000",
    p_licenses: [
      { category_id: cat.id, license_type: "drug_license", license_number: "X" },
    ],
  });
  expect(badPhone?.message ?? "").toMatch(/not_found_or_unauthorized|identity_required/);

  await supabaseAdmin.storage.from("vendor-docs").remove([path]);
});

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("VL-02 — anon cannot write or list another vendor's license-docs", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");
  const victimPhone = `99053${String(T).slice(-5)}`;
  const { data: victim, error: insErr } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: victimPhone,
      name: "License Victim",
      shop_name: `!LIC-V-${T}`,
      category: cat.label,
      service_mode: cat.service_mode,
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(insErr, insErr?.message).toBeNull();
  createdVendorIds.push(victim!.id);

  const victimPath = `license-docs/${victim!.id}/${cat.id}/secret_${T}.png`;
  const { error: seedErr } = await supabaseAdmin.storage
    .from("vendor-docs")
    .upload(victimPath, PNG_1PX, { contentType: "image/png", upsert: true });
  expect(seedErr, seedErr?.message).toBeNull();

  const { error: crossUpload } = await supabase.storage
    .from("vendor-docs")
    .upload(`license-docs/${victim!.id}/${cat.id}/anon_cross_${T}.png`, PNG_1PX, {
      contentType: "image/png",
      upsert: true,
    });
  expect(crossUpload, "anon must not upload into another vendor folder").not.toBeNull();

  const { error: fakeFolder } = await supabase.storage
    .from("vendor-docs")
    .upload(`license-docs/not-a-vendor-id/x_${T}.png`, PNG_1PX, {
      contentType: "image/png",
      upsert: true,
    });
  expect(fakeFolder, "anon must not upload into a non-owned license-docs path").not.toBeNull();

  const { data: listedRoot, error: listRootErr } = await supabase.storage
    .from("vendor-docs")
    .list("license-docs", { limit: 100 });
  expect(listRootErr ?? null).toBeNull();
  const listedNames = (listedRoot ?? []).map((e) => e.name);
  expect(listedNames).not.toContain(victim!.id);
  expect(listedNames.some((n) => n.includes(victim!.id))).toBe(false);

  const { data: listedVictim } = await supabase.storage
    .from("vendor-docs")
    .list(`license-docs/${victim!.id}`, { limit: 100 });
  expect(listedVictim ?? []).toHaveLength(0);

  await supabaseAdmin.storage.from("vendor-docs").remove([victimPath]);
});

test("VL-03 — signed-in vendor can write own license-docs, not another vendor's", async () => {
  const cat = await getActiveCategoryByLabel("Pharmacy");
  const ownerPhone = `99054${String(T).slice(-5)}`;
  const otherPhone = `99055${String(T).slice(-5)}`;

  const { data: ownerVendor, error: ownerIns } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: ownerPhone,
      name: "License Owner",
      shop_name: `!LIC-O-${T}`,
      category: cat.label,
      service_mode: cat.service_mode,
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(ownerIns, ownerIns?.message).toBeNull();
  createdVendorIds.push(ownerVendor!.id);

  const { data: otherVendor, error: otherIns } = await supabaseAdmin
    .from("vendors")
    .insert({
      phone: otherPhone,
      name: "License Other",
      shop_name: `!LIC-X-${T}`,
      category: cat.label,
      service_mode: cat.service_mode,
      is_active: true,
      discoverable: true,
      profile_status: "complete",
      latitude: 18.5204,
      longitude: 73.8567,
      service_radius_km: 15,
      shop_photo_url: "https://example.com/shop.jpg",
      photo_selfie: "https://example.com/selfie.jpg",
      verification_status: "identity_linked",
    })
    .select("id")
    .single();
  expect(otherIns, otherIns?.message).toBeNull();
  createdVendorIds.push(otherVendor!.id);

  const email = `lic.own.${T}@aaspaas.invalid`;
  const password = `lic_pw_${T}`;
  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    phone: `+91${ownerPhone}`,
    email_confirm: true,
    phone_confirm: true,
  });
  expect(createErr, createErr?.message).toBeNull();

  const ownerClient = createClient(getSupabaseUrl(), getAnonKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const { error: signErr } = await ownerClient.auth.signInWithPassword({ email, password });
    expect(signErr, signErr?.message).toBeNull();

    const ownPath = `license-docs/${ownerVendor!.id}/${cat.id}/own_${T}.png`;
    const { error: ownUp } = await ownerClient.storage.from("vendor-docs").upload(ownPath, PNG_1PX, {
      contentType: "image/png",
      upsert: true,
    });
    expect(ownUp, ownUp?.message).toBeNull();

    const { error: crossUp } = await ownerClient.storage
      .from("vendor-docs")
      .upload(`license-docs/${otherVendor!.id}/${cat.id}/cross_${T}.png`, PNG_1PX, {
        contentType: "image/png",
        upsert: true,
      });
    expect(crossUp, "signed-in vendor must not write another vendor folder").not.toBeNull();

    const { data: listed } = await ownerClient.storage
      .from("vendor-docs")
      .list("license-docs", { limit: 100 });
    const names = (listed ?? []).map((e) => e.name);
    expect(names).toContain(ownerVendor!.id);
    expect(names).not.toContain(otherVendor!.id);

    await supabaseAdmin.storage.from("vendor-docs").remove([ownPath]);
  } finally {
    if (created?.user?.id) {
      await supabaseAdmin.auth.admin.deleteUser(created.user.id);
    }
  }
});

test("VL-04 — direct UPDATE of license_review_status is blocked", async () => {
  const label = `!LIC-G-${T}`;
  const { data: cat, error: insErr } = await supabaseAdmin
    .from("categories")
    .insert({
      label,
      emoji: "🔒",
      service_mode: "help",
      is_active: true,
      pending_review: false,
      status: "active",
      sort_order: 99,
      license_type: "Drug License",
      license_confidence_score: 0.9,
      license_reasoning: "guard probe",
      license_review_status: "pending_review",
    })
    .select("id, license_review_status")
    .single();
  expect(insErr, insErr?.message).toBeNull();

  try {
    const { error: directErr } = await supabase
      .from("categories")
      .update({ license_review_status: "approved" })
      .eq("id", cat!.id);

    if (directErr) {
      expect(directErr.message).toMatch(
        /direct admin column write blocked on categories|row-level security|permission|violates/i,
      );
    }

    const { data: after } = await supabaseAdmin
      .from("categories")
      .select("license_review_status")
      .eq("id", cat!.id)
      .single();
    expect(after?.license_review_status).toBe("pending_review");
  } finally {
    await supabaseAdmin.from("categories").delete().eq("id", cat!.id);
  }
});
