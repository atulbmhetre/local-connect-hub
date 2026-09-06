/**
 * Vendor referral_code: AASP + last 4 phone digits; suffix on collision.
 */
import { test, expect } from "@playwright/test";
import {
  supabaseAdmin,
  invokeRegisterVendorRpc,
  deleteVendorRegistrationArtifacts,
  getFirstActiveCategory,
} from "./helpers/setup";

const createdVendorIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdVendorIds) {
    await deleteVendorRegistrationArtifacts(id);
  }
});

async function cleanupPhone(phone: string) {
  const { data } = await supabaseAdmin.from("vendors").select("id").eq("phone", phone);
  for (const row of data ?? []) {
    await deleteVendorRegistrationArtifacts(row.id);
  }
}

test("REF-COLL-01 — second vendor with same last-4 phone digits gets suffixed referral_code", async () => {
  const phoneA = "9000001234";
  const phoneB = "8000001234";
  await cleanupPhone(phoneA);
  await cleanupPhone(phoneB);

  const category = await getFirstActiveCategory();

  const first = await invokeRegisterVendorRpc({
    phone: phoneA,
    referral_code: "AASP1234",
    category: category.label,
    service_mode: category.service_mode,
    is_active: false,
  });
  expect(first.error).toBeUndefined();
  expect(first.vendorId).toBeTruthy();
  createdVendorIds.push(first.vendorId!);

  const { data: vendorA } = await supabaseAdmin
    .from("vendors")
    .select("referral_code")
    .eq("id", first.vendorId!)
    .single();
  expect(vendorA?.referral_code).toBe("AASP1234");

  const second = await invokeRegisterVendorRpc({
    phone: phoneB,
    referral_code: "AASP1234",
    category: category.label,
    service_mode: category.service_mode,
    is_active: false,
  });
  expect(second.error).toBeUndefined();
  expect(second.vendorId).toBeTruthy();
  createdVendorIds.push(second.vendorId!);

  const { data: vendorB } = await supabaseAdmin
    .from("vendors")
    .select("referral_code")
    .eq("id", second.vendorId!)
    .single();
  expect(vendorB?.referral_code).toBe("AASP12341");
  expect(vendorB?.referral_code).not.toBe(vendorA?.referral_code);
});
