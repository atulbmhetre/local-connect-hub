import { supabase, meetsGreenCriteria, type Vendor } from "@/lib/supabase";

/**
 * After verification-related vendor updates: if green criteria are met but admin
 * has not approved, mark green_pending once (deduped via verification_status).
 */
export async function checkAndNotifyAdminGreenReady(vendorId: string): Promise<void> {
  try {
    const { data: vendor, error } = await supabase
      .from("vendors")
      .select(
        "id, shop_name, phone, shop_photo_url, upi_verified, verification_status, is_manual_verified",
      )
      .eq("id", vendorId)
      .maybeSingle();

    if (error || !vendor) return;

    const v = vendor as Vendor;
    if (v.verification_status === "green_pending") return;
    if (v.is_manual_verified) return;
    if (!meetsGreenCriteria(v)) return;

    const { error: updateErr } = await supabase
      .from("vendors")
      .update({ verification_status: "green_pending" })
      .eq("id", vendorId)
      .neq("verification_status", "green_pending")
      .eq("is_manual_verified", false);

    if (updateErr) return;
  } catch (err) {
    console.error("checkAndNotifyAdminGreenReady", err);
  }
}
