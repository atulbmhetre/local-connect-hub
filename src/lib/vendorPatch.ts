import { supabase } from "@/lib/supabase";

export async function patchVendorOwn(
  vendorId: string,
  vendorPhone: string,
  patch: Record<string, unknown>,
) {
  return supabase.rpc("vendor_update_own", {
    p_vendor_id: vendorId,
    p_vendor_phone: vendorPhone,
    p_patch: patch,
  });
}

export async function fetchVendorPhone(vendorId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("vendors")
    .select("phone")
    .eq("id", vendorId)
    .maybeSingle();
  if (error || !data?.phone) return null;
  return String(data.phone).trim() || null;
}
