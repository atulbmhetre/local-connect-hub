import { supabase } from "@/lib/supabase";

export async function persistVendorServiceRadius(
  vendorId: string,
  serviceRadiusKm: number,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const { error } = await supabase
    .from("vendors")
    .update({ service_radius_km: serviceRadiusKm })
    .eq("id", vendorId);
  if (error) {
    return { ok: false, errorMessage: error.message };
  }
  return { ok: true };
}
