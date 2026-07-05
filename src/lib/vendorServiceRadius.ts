import { patchVendorOwn } from "@/lib/vendorPatch";
import { throwOnSupabaseNetworkError } from "@/lib/withNetworkRetry";

export async function persistVendorServiceRadius(
  vendorId: string,
  vendorPhone: string,
  serviceRadiusKm: number,
): Promise<{ ok: boolean; errorMessage?: string }> {
  const { error } = throwOnSupabaseNetworkError(
    await patchVendorOwn(vendorId, vendorPhone, {
      service_radius_km: serviceRadiusKm,
    }),
  );
  if (error) {
    return { ok: false, errorMessage: error.message };
  }
  return { ok: true };
}
