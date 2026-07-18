import { supabase } from "@/lib/supabase";
import { getUserPhone } from "@/lib/userIdentity";

export async function patchVendorOwn(
  vendorId: string,
  vendorPhone: string,
  patch: Record<string, unknown>,
) {
  const { discoverable: _discoverable, ...safePatch } = patch;
  return supabase.rpc("vendor_update_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_patch: safePatch,
  });
}

/**
 * Resolves the vendor's own phone from localStorage identity, verified via
 * get_vendor_own (id+phone must match). A direct vendors read only works for
 * discoverable vendors under the public RLS policy, so hidden/offline vendors
 * would get null here.
 */
export async function fetchVendorPhone(vendorId: string): Promise<string | null> {
  const storedPhone = getUserPhone()?.trim();
  if (!storedPhone) return null;
  const { data, error } = await supabase.rpc("get_vendor_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: storedPhone,
  });
  if (error || !data?.phone) return null;
  return String(data.phone).trim() || null;
}
