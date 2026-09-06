import { supabase } from "@/lib/supabase";
import { logAdminAction } from "@/lib/adminAudit";
import { getUserPhone } from "@/lib/userIdentity";

export type ApplyVendorWaiveoffConfig = {
  localizationEnabled: boolean;
  langHindiEnabled: boolean;
  langMarathiEnabled: boolean;
};

export type ApplyVendorWaiveoffResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Apply a subscription waive-off via admin_apply_vendor_waiveoff.
 * Vendor subscription_update notify is fired by DB trigger on vendors
 * waiveoff_percent / waiveoff_months_remaining.
 */
export async function applyVendorWaiveoff(
  vendor: { id: string; phone: string | null },
  percent: number,
  months: number,
  _config: ApplyVendorWaiveoffConfig,
  adminLabel?: string | null,
): Promise<ApplyVendorWaiveoffResult> {
  const p_admin_phone = adminLabel ?? (getUserPhone()?.trim() || null);

  const { error: applyError } = await supabase.rpc("admin_apply_vendor_waiveoff", {
    p_admin_phone,
    p_vendor_id: vendor.id,
    p_percent: percent,
    p_months: months,
  });
  if (applyError) {
    return { ok: false, error: applyError.message };
  }

  logAdminAction(
    "update_config",
    "vendor",
    vendor.id,
    `waiveoff:${percent}%x${months}months`,
    adminLabel,
  );

  return { ok: true };
}
