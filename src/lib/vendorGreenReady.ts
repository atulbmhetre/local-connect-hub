import { supabase } from "@/lib/supabase";

/**
 * After verification-related vendor updates: if green criteria are met but admin
 * has not approved, mark green_pending once (deduped via verification_status).
 *
 * All criteria checks live server-side in vendor_promote_green_pending
 * (business_verified status, photo, verified UPI, valid phone, not manual
 * verified, not already pending) — the old client pre-read of the vendors row
 * silently failed for hidden/draft vendors under the public discoverability RLS.
 */
export async function checkAndNotifyAdminGreenReady(vendorId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc("vendor_promote_green_pending", {
      p_vendor_id: vendorId,
    });
    if (error) return;
  } catch (err) {
    console.error("checkAndNotifyAdminGreenReady", err);
  }
}
